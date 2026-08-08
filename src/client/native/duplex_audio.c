#include "duplex_audio.h"

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_GENERATION
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS

#if defined(__APPLE__)
#define MA_ENABLE_COREAUDIO
#elif defined(_WIN32)
#define MA_ENABLE_WASAPI
#elif defined(__linux__)
#define MA_ENABLE_ALSA
#define MA_ENABLE_PULSEAUDIO
#else
#error "agentvoicenext duplex audio does not support this platform"
#endif

#define MINIAUDIO_IMPLEMENTATION
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#include "vendor/miniaudio.h"
#pragma GCC diagnostic pop

typedef struct {
    ma_device_id id;
    char name[MA_MAX_DEVICE_NAME_LENGTH + 1];
    ma_bool32 is_default;
} avn_device_entry;

enum {
    AVN_PLAYBACK_STARVATION_EVENT_CAPACITY = 64,
};

typedef struct {
    _Atomic(uint64_t) sequence;
    _Atomic(uint64_t) callback_count;
    _Atomic(uint32_t) available_frames;
    _Atomic(uint32_t) requested_frames;
    _Atomic(uint32_t) read_frames;
} avn_playback_starvation_slot;

struct avn_duplex {
    ma_context context;
    bool context_initialized;
    ma_device device;
    bool device_initialized;
    ma_pcm_rb capture_ring;
    bool capture_ring_initialized;
    ma_pcm_rb playback_ring;
    bool playback_ring_initialized;
    avn_device_entry* capture_devices;
    uint32_t capture_device_count;
    avn_device_entry* playback_devices;
    uint32_t playback_device_count;
    uint32_t playback_start_frames;
    atomic_bool playback_running;
    atomic_bool clear_playback_requested;
    _Atomic(uint64_t) callback_count;
    _Atomic(uint32_t) max_callback_frames;
    _Atomic(uint64_t) capture_received_frames;
    _Atomic(uint64_t) capture_read_frames;
    _Atomic(uint64_t) capture_dropped_frames;
    _Atomic(uint64_t) playback_submitted_frames;
    _Atomic(uint64_t) playback_written_frames;
    _Atomic(uint64_t) playback_dropped_frames;
    _Atomic(uint64_t) playback_rendered_frames;
    _Atomic(uint64_t) playback_starvation_count;
    _Atomic(uint64_t) playback_starved_frames;
    avn_playback_starvation_slot playback_starvation_events[
        AVN_PLAYBACK_STARVATION_EVENT_CAPACITY
    ];
    _Atomic(uint64_t) started_notifications;
    _Atomic(uint64_t) stopped_notifications;
    _Atomic(uint64_t) rerouted_notifications;
    _Atomic(uint64_t) interruption_began_notifications;
    _Atomic(uint64_t) interruption_ended_notifications;
};

static const char* avn_empty_string = "";
static int32_t avn_refresh_devices(avn_duplex* duplex);

static void avn_init_atomics(avn_duplex* duplex)
{
    atomic_init(&duplex->playback_running, false);
    atomic_init(&duplex->clear_playback_requested, false);
    atomic_init(&duplex->callback_count, 0);
    atomic_init(&duplex->max_callback_frames, 0);
    atomic_init(&duplex->capture_received_frames, 0);
    atomic_init(&duplex->capture_read_frames, 0);
    atomic_init(&duplex->capture_dropped_frames, 0);
    atomic_init(&duplex->playback_submitted_frames, 0);
    atomic_init(&duplex->playback_written_frames, 0);
    atomic_init(&duplex->playback_dropped_frames, 0);
    atomic_init(&duplex->playback_rendered_frames, 0);
    atomic_init(&duplex->playback_starvation_count, 0);
    atomic_init(&duplex->playback_starved_frames, 0);
    for (uint32_t index = 0; index < AVN_PLAYBACK_STARVATION_EVENT_CAPACITY; index += 1) {
        atomic_init(&duplex->playback_starvation_events[index].sequence, 0);
        atomic_init(&duplex->playback_starvation_events[index].callback_count, 0);
        atomic_init(&duplex->playback_starvation_events[index].available_frames, 0);
        atomic_init(&duplex->playback_starvation_events[index].requested_frames, 0);
        atomic_init(&duplex->playback_starvation_events[index].read_frames, 0);
    }
    atomic_init(&duplex->started_notifications, 0);
    atomic_init(&duplex->stopped_notifications, 0);
    atomic_init(&duplex->rerouted_notifications, 0);
    atomic_init(&duplex->interruption_began_notifications, 0);
    atomic_init(&duplex->interruption_ended_notifications, 0);
}

static uint32_t avn_ring_write(
    ma_pcm_rb* ring,
    const void* source,
    uint32_t frame_count,
    size_t bytes_per_frame
)
{
    uint32_t written = 0;
    while (written < frame_count) {
        uint32_t acquired = frame_count - written;
        void* destination = NULL;
        if (ma_pcm_rb_acquire_write(ring, &acquired, &destination) != MA_SUCCESS || acquired == 0) {
            break;
        }
        memcpy(
            destination,
            (const uint8_t*)source + ((size_t)written * bytes_per_frame),
            (size_t)acquired * bytes_per_frame
        );
        if (ma_pcm_rb_commit_write(ring, acquired) != MA_SUCCESS) {
            break;
        }
        written += acquired;
    }
    return written;
}

static uint32_t avn_ring_read(
    ma_pcm_rb* ring,
    void* destination,
    uint32_t frame_count,
    size_t bytes_per_frame
)
{
    uint32_t read = 0;
    while (read < frame_count) {
        uint32_t acquired = frame_count - read;
        void* source = NULL;
        if (ma_pcm_rb_acquire_read(ring, &acquired, &source) != MA_SUCCESS || acquired == 0) {
            break;
        }
        memcpy(
            (uint8_t*)destination + ((size_t)read * bytes_per_frame),
            source,
            (size_t)acquired * bytes_per_frame
        );
        if (ma_pcm_rb_commit_read(ring, acquired) != MA_SUCCESS) {
            break;
        }
        read += acquired;
    }
    return read;
}

static void avn_discard_playback(avn_duplex* duplex)
{
    uint32_t available = ma_pcm_rb_available_read(&duplex->playback_ring);
    if (available > 0) {
        (void)ma_pcm_rb_seek_read(&duplex->playback_ring, available);
    }
    atomic_store_explicit(&duplex->playback_running, false, memory_order_relaxed);
}

static void avn_update_max_callback_frames(avn_duplex* duplex, uint32_t frame_count)
{
    uint32_t previous = atomic_load_explicit(
        &duplex->max_callback_frames,
        memory_order_relaxed
    );
    while (previous < frame_count &&
           !atomic_compare_exchange_weak_explicit(
               &duplex->max_callback_frames,
               &previous,
               frame_count,
               memory_order_relaxed,
               memory_order_relaxed
           )) {
    }
}

static void avn_record_playback_starvation(
    avn_duplex* duplex,
    uint32_t available_frames,
    uint32_t requested_frames,
    uint32_t read_frames
)
{
    /* The data callback is the sole writer; publish the count after its slot. */
    uint64_t sequence = atomic_load_explicit(
        &duplex->playback_starvation_count,
        memory_order_relaxed
    ) + 1;
    avn_playback_starvation_slot* slot = &duplex->playback_starvation_events[
        (sequence - 1) % AVN_PLAYBACK_STARVATION_EVENT_CAPACITY
    ];

    /* Zeroing the sequence keeps readers from accepting a slot while it is replaced. */
    atomic_store_explicit(&slot->sequence, 0, memory_order_release);
    atomic_store_explicit(
        &slot->callback_count,
        atomic_load_explicit(&duplex->callback_count, memory_order_relaxed),
        memory_order_relaxed
    );
    atomic_store_explicit(&slot->available_frames, available_frames, memory_order_relaxed);
    atomic_store_explicit(&slot->requested_frames, requested_frames, memory_order_relaxed);
    atomic_store_explicit(&slot->read_frames, read_frames, memory_order_relaxed);
    atomic_store_explicit(&slot->sequence, sequence, memory_order_release);
    atomic_store_explicit(
        &duplex->playback_starvation_count,
        sequence,
        memory_order_release
    );
}

static void avn_data_callback(
    ma_device* device,
    void* output,
    const void* input,
    ma_uint32 frame_count
)
{
    avn_duplex* duplex = (avn_duplex*)device->pUserData;
    if (duplex == NULL) {
        return;
    }

    atomic_fetch_add_explicit(&duplex->callback_count, 1, memory_order_relaxed);
    avn_update_max_callback_frames(duplex, frame_count);

    if (input != NULL) {
        atomic_fetch_add_explicit(
            &duplex->capture_received_frames,
            frame_count,
            memory_order_relaxed
        );
        uint32_t written = avn_ring_write(
            &duplex->capture_ring,
            input,
            frame_count,
            AVN_DUPLEX_CAPTURE_CHANNELS * sizeof(int16_t)
        );
        if (written < frame_count) {
            atomic_fetch_add_explicit(
                &duplex->capture_dropped_frames,
                frame_count - written,
                memory_order_relaxed
            );
        }
    }

    if (output == NULL) {
        return;
    }
    memset(
        output,
        0,
        (size_t)frame_count * AVN_DUPLEX_PLAYBACK_CHANNELS * sizeof(int16_t)
    );

    if (atomic_exchange_explicit(
            &duplex->clear_playback_requested,
            false,
            memory_order_acquire
        )) {
        avn_discard_playback(duplex);
        return;
    }

    uint32_t available = ma_pcm_rb_available_read(&duplex->playback_ring);
    if (!atomic_load_explicit(&duplex->playback_running, memory_order_relaxed)) {
        if (available < duplex->playback_start_frames) {
            return;
        }
        atomic_store_explicit(&duplex->playback_running, true, memory_order_relaxed);
    }

    uint32_t read = avn_ring_read(
        &duplex->playback_ring,
        output,
        frame_count,
        AVN_DUPLEX_PLAYBACK_CHANNELS * sizeof(int16_t)
    );
    if (read > 0) {
        atomic_fetch_add_explicit(
            &duplex->playback_rendered_frames,
            read,
            memory_order_relaxed
        );
    }
    if (read < frame_count) {
        atomic_store_explicit(&duplex->playback_running, false, memory_order_relaxed);
        atomic_fetch_add_explicit(
            &duplex->playback_starved_frames,
            frame_count - read,
            memory_order_relaxed
        );
        avn_record_playback_starvation(duplex, available, frame_count, read);
    }
}

static void avn_notification_callback(const ma_device_notification* notification)
{
    if (notification == NULL || notification->pDevice == NULL) {
        return;
    }
    avn_duplex* duplex = (avn_duplex*)notification->pDevice->pUserData;
    if (duplex == NULL) {
        return;
    }
    switch (notification->type) {
        case ma_device_notification_type_started:
            atomic_fetch_add_explicit(&duplex->started_notifications, 1, memory_order_relaxed);
            break;
        case ma_device_notification_type_stopped:
            atomic_fetch_add_explicit(&duplex->stopped_notifications, 1, memory_order_relaxed);
            break;
        case ma_device_notification_type_rerouted:
            atomic_fetch_add_explicit(&duplex->rerouted_notifications, 1, memory_order_relaxed);
            break;
        case ma_device_notification_type_interruption_began:
            atomic_fetch_add_explicit(
                &duplex->interruption_began_notifications,
                1,
                memory_order_relaxed
            );
            break;
        case ma_device_notification_type_interruption_ended:
            atomic_fetch_add_explicit(
                &duplex->interruption_ended_notifications,
                1,
                memory_order_relaxed
            );
            break;
        case ma_device_notification_type_unlocked:
            break;
    }
}

static int32_t avn_copy_devices(
    avn_duplex* duplex,
    const ma_device_info* capture_infos,
    uint32_t capture_count,
    const ma_device_info* playback_infos,
    uint32_t playback_count
)
{
    avn_device_entry* next_capture = NULL;
    avn_device_entry* next_playback = NULL;
    if (capture_count > 0) {
        next_capture = (avn_device_entry*)calloc(capture_count, sizeof(*next_capture));
        if (next_capture == NULL) {
            return MA_OUT_OF_MEMORY;
        }
    }
    if (playback_count > 0) {
        next_playback = (avn_device_entry*)calloc(playback_count, sizeof(*next_playback));
        if (next_playback == NULL) {
            free(next_capture);
            return MA_OUT_OF_MEMORY;
        }
    }

    for (uint32_t index = 0; index < capture_count; index += 1) {
        next_capture[index].id = capture_infos[index].id;
        memcpy(next_capture[index].name, capture_infos[index].name, sizeof(next_capture[index].name));
        next_capture[index].name[MA_MAX_DEVICE_NAME_LENGTH] = '\0';
        next_capture[index].is_default = capture_infos[index].isDefault;
    }
    for (uint32_t index = 0; index < playback_count; index += 1) {
        next_playback[index].id = playback_infos[index].id;
        memcpy(next_playback[index].name, playback_infos[index].name, sizeof(next_playback[index].name));
        next_playback[index].name[MA_MAX_DEVICE_NAME_LENGTH] = '\0';
        next_playback[index].is_default = playback_infos[index].isDefault;
    }

    free(duplex->capture_devices);
    free(duplex->playback_devices);
    duplex->capture_devices = next_capture;
    duplex->capture_device_count = capture_count;
    duplex->playback_devices = next_playback;
    duplex->playback_device_count = playback_count;
    return MA_SUCCESS;
}

uint32_t avn_duplex_abi_version(void)
{
    return AVN_DUPLEX_ABI_VERSION;
}

const char* avn_duplex_miniaudio_version(void)
{
    return ma_version_string();
}

const char* avn_duplex_result_description(int32_t result)
{
    return ma_result_description((ma_result)result);
}

avn_duplex* avn_duplex_create(
    uint32_t capture_capacity_frames,
    uint32_t playback_capacity_frames,
    uint32_t playback_start_frames
)
{
    if (capture_capacity_frames == 0 || playback_capacity_frames == 0 ||
        playback_start_frames == 0 || playback_start_frames > playback_capacity_frames) {
        return NULL;
    }
    avn_duplex* duplex = (avn_duplex*)calloc(1, sizeof(*duplex));
    if (duplex == NULL) {
        return NULL;
    }
    avn_init_atomics(duplex);
    duplex->playback_start_frames = playback_start_frames;

    ma_result result = ma_context_init(NULL, 0, NULL, &duplex->context);
    if (result != MA_SUCCESS) {
        avn_duplex_destroy(duplex);
        return NULL;
    }
    duplex->context_initialized = true;

    result = ma_pcm_rb_init(
        ma_format_s16,
        AVN_DUPLEX_CAPTURE_CHANNELS,
        capture_capacity_frames,
        NULL,
        NULL,
        &duplex->capture_ring
    );
    if (result != MA_SUCCESS) {
        avn_duplex_destroy(duplex);
        return NULL;
    }
    duplex->capture_ring_initialized = true;
    ma_pcm_rb_set_sample_rate(&duplex->capture_ring, AVN_DUPLEX_SAMPLE_RATE);

    result = ma_pcm_rb_init(
        ma_format_s16,
        AVN_DUPLEX_PLAYBACK_CHANNELS,
        playback_capacity_frames,
        NULL,
        NULL,
        &duplex->playback_ring
    );
    if (result != MA_SUCCESS) {
        avn_duplex_destroy(duplex);
        return NULL;
    }
    duplex->playback_ring_initialized = true;
    ma_pcm_rb_set_sample_rate(&duplex->playback_ring, AVN_DUPLEX_SAMPLE_RATE);

    if (avn_refresh_devices(duplex) != MA_SUCCESS) {
        avn_duplex_destroy(duplex);
        return NULL;
    }
    return duplex;
}

void avn_duplex_destroy(avn_duplex* duplex)
{
    if (duplex == NULL) {
        return;
    }
    avn_duplex_stop(duplex);
    if (duplex->playback_ring_initialized) {
        ma_pcm_rb_uninit(&duplex->playback_ring);
    }
    if (duplex->capture_ring_initialized) {
        ma_pcm_rb_uninit(&duplex->capture_ring);
    }
    if (duplex->context_initialized) {
        ma_context_uninit(&duplex->context);
    }
    free(duplex->capture_devices);
    free(duplex->playback_devices);
    free(duplex);
}

static int32_t avn_refresh_devices(avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->context_initialized) {
        return MA_INVALID_ARGS;
    }
    if (duplex->device_initialized) {
        return MA_DEVICE_ALREADY_INITIALIZED;
    }
    ma_device_info* playback_infos = NULL;
    ma_device_info* capture_infos = NULL;
    ma_uint32 playback_count = 0;
    ma_uint32 capture_count = 0;
    ma_result result = ma_context_get_devices(
        &duplex->context,
        &playback_infos,
        &playback_count,
        &capture_infos,
        &capture_count
    );
    if (result != MA_SUCCESS) {
        return result;
    }
    return avn_copy_devices(
        duplex,
        capture_infos,
        capture_count,
        playback_infos,
        playback_count
    );
}

uint32_t avn_duplex_capture_device_count(const avn_duplex* duplex)
{
    return duplex == NULL ? 0 : duplex->capture_device_count;
}

uint32_t avn_duplex_playback_device_count(const avn_duplex* duplex)
{
    return duplex == NULL ? 0 : duplex->playback_device_count;
}

const char* avn_duplex_capture_device_name(const avn_duplex* duplex, uint32_t index)
{
    if (duplex == NULL || index >= duplex->capture_device_count) {
        return avn_empty_string;
    }
    return duplex->capture_devices[index].name;
}

const char* avn_duplex_playback_device_name(const avn_duplex* duplex, uint32_t index)
{
    if (duplex == NULL || index >= duplex->playback_device_count) {
        return avn_empty_string;
    }
    return duplex->playback_devices[index].name;
}

uint32_t avn_duplex_capture_device_is_default(const avn_duplex* duplex, uint32_t index)
{
    if (duplex == NULL || index >= duplex->capture_device_count) {
        return 0;
    }
    return duplex->capture_devices[index].is_default == MA_TRUE;
}

uint32_t avn_duplex_playback_device_is_default(const avn_duplex* duplex, uint32_t index)
{
    if (duplex == NULL || index >= duplex->playback_device_count) {
        return 0;
    }
    return duplex->playback_devices[index].is_default == MA_TRUE;
}

int32_t avn_duplex_start(
    avn_duplex* duplex,
    int32_t capture_device_index,
    int32_t playback_device_index
)
{
    if (duplex == NULL || !duplex->context_initialized) {
        return MA_INVALID_ARGS;
    }
    if (duplex->device_initialized) {
        return MA_DEVICE_ALREADY_INITIALIZED;
    }
    if (capture_device_index >= 0 &&
        (uint32_t)capture_device_index >= duplex->capture_device_count) {
        return MA_DOES_NOT_EXIST;
    }
    if (playback_device_index >= 0 &&
        (uint32_t)playback_device_index >= duplex->playback_device_count) {
        return MA_DOES_NOT_EXIST;
    }

    ma_pcm_rb_reset(&duplex->capture_ring);
    ma_pcm_rb_reset(&duplex->playback_ring);
    atomic_store_explicit(&duplex->playback_running, false, memory_order_relaxed);
    atomic_store_explicit(&duplex->clear_playback_requested, false, memory_order_relaxed);

    ma_device_config config = ma_device_config_init(ma_device_type_duplex);
    config.sampleRate = AVN_DUPLEX_SAMPLE_RATE;
    config.capture.format = ma_format_s16;
    config.capture.channels = AVN_DUPLEX_CAPTURE_CHANNELS;
    config.playback.format = ma_format_s16;
    config.playback.channels = AVN_DUPLEX_PLAYBACK_CHANNELS;
    config.dataCallback = avn_data_callback;
    config.notificationCallback = avn_notification_callback;
    config.pUserData = duplex;
    if (capture_device_index >= 0) {
        config.capture.pDeviceID = &duplex->capture_devices[capture_device_index].id;
    }
    if (playback_device_index >= 0) {
        config.playback.pDeviceID = &duplex->playback_devices[playback_device_index].id;
    }

    ma_result result = ma_device_init(&duplex->context, &config, &duplex->device);
    if (result != MA_SUCCESS) {
        return result;
    }
    duplex->device_initialized = true;
    result = ma_device_start(&duplex->device);
    if (result != MA_SUCCESS) {
        ma_device_uninit(&duplex->device);
        duplex->device_initialized = false;
        return result;
    }
    return MA_SUCCESS;
}

int32_t avn_duplex_stop(avn_duplex* duplex)
{
    if (duplex == NULL) {
        return MA_INVALID_ARGS;
    }
    if (!duplex->device_initialized) {
        return MA_SUCCESS;
    }
    ma_result result = ma_device_stop(&duplex->device);
    ma_device_uninit(&duplex->device);
    duplex->device_initialized = false;
    ma_pcm_rb_reset(&duplex->capture_ring);
    ma_pcm_rb_reset(&duplex->playback_ring);
    atomic_store_explicit(&duplex->playback_running, false, memory_order_relaxed);
    atomic_store_explicit(&duplex->clear_playback_requested, false, memory_order_relaxed);
    if (result == MA_DEVICE_NOT_STARTED) {
        return MA_SUCCESS;
    }
    return result;
}

uint32_t avn_duplex_is_started(const avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->device_initialized) {
        return 0;
    }
    ma_device_state state = ma_device_get_state((ma_device*)&duplex->device);
    return state == ma_device_state_starting || state == ma_device_state_started;
}

uint32_t avn_duplex_device_state(const avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->device_initialized) {
        return ma_device_state_uninitialized;
    }
    return (uint32_t)ma_device_get_state((ma_device*)&duplex->device);
}

uint32_t avn_duplex_read_capture(
    avn_duplex* duplex,
    int16_t* frames,
    uint32_t frame_count
)
{
    if (duplex == NULL || frames == NULL || frame_count == 0 ||
        ma_pcm_rb_available_read(&duplex->capture_ring) < frame_count) {
        return 0;
    }
    uint32_t read = avn_ring_read(
        &duplex->capture_ring,
        frames,
        frame_count,
        AVN_DUPLEX_CAPTURE_CHANNELS * sizeof(int16_t)
    );
    atomic_fetch_add_explicit(&duplex->capture_read_frames, read, memory_order_relaxed);
    return read;
}

uint32_t avn_duplex_write_playback(
    avn_duplex* duplex,
    const int16_t* frames,
    uint32_t frame_count
)
{
    if (duplex == NULL || frames == NULL || frame_count == 0 ||
        !duplex->device_initialized) {
        return 0;
    }
    atomic_fetch_add_explicit(
        &duplex->playback_submitted_frames,
        frame_count,
        memory_order_relaxed
    );
    uint32_t written = avn_ring_write(
        &duplex->playback_ring,
        frames,
        frame_count,
        AVN_DUPLEX_PLAYBACK_CHANNELS * sizeof(int16_t)
    );
    atomic_fetch_add_explicit(&duplex->playback_written_frames, written, memory_order_relaxed);
    if (written < frame_count) {
        atomic_fetch_add_explicit(
            &duplex->playback_dropped_frames,
            frame_count - written,
            memory_order_relaxed
        );
    }
    return written;
}

void avn_duplex_clear_playback(avn_duplex* duplex)
{
    if (duplex == NULL) {
        return;
    }
    if (duplex->device_initialized) {
        atomic_store_explicit(&duplex->clear_playback_requested, true, memory_order_release);
    } else {
        ma_pcm_rb_reset(&duplex->playback_ring);
        atomic_store_explicit(&duplex->playback_running, false, memory_order_relaxed);
    }
}

const char* avn_duplex_backend_name(const avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->context_initialized) {
        return avn_empty_string;
    }
    return ma_get_backend_name(duplex->context.backend);
}

const char* avn_duplex_active_capture_device_name(const avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->device_initialized) {
        return avn_empty_string;
    }
    return duplex->device.capture.name;
}

const char* avn_duplex_active_playback_device_name(const avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->device_initialized) {
        return avn_empty_string;
    }
    return duplex->device.playback.name;
}

const char* avn_duplex_capture_internal_format(const avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->device_initialized) {
        return avn_empty_string;
    }
    return ma_get_format_name(duplex->device.capture.internalFormat);
}

const char* avn_duplex_playback_internal_format(const avn_duplex* duplex)
{
    if (duplex == NULL || !duplex->device_initialized) {
        return avn_empty_string;
    }
    return ma_get_format_name(duplex->device.playback.internalFormat);
}

uint32_t avn_duplex_capture_internal_sample_rate(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->device_initialized
        ? 0
        : duplex->device.capture.internalSampleRate;
}

uint32_t avn_duplex_playback_internal_sample_rate(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->device_initialized
        ? 0
        : duplex->device.playback.internalSampleRate;
}

uint32_t avn_duplex_capture_internal_channels(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->device_initialized
        ? 0
        : duplex->device.capture.internalChannels;
}

uint32_t avn_duplex_playback_internal_channels(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->device_initialized
        ? 0
        : duplex->device.playback.internalChannels;
}

uint32_t avn_duplex_capture_period_frames(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->device_initialized
        ? 0
        : duplex->device.capture.internalPeriodSizeInFrames;
}

uint32_t avn_duplex_playback_period_frames(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->device_initialized
        ? 0
        : duplex->device.playback.internalPeriodSizeInFrames;
}

uint32_t avn_duplex_capture_buffered_frames(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->capture_ring_initialized
        ? 0
        : ma_pcm_rb_available_read((ma_pcm_rb*)&duplex->capture_ring);
}

uint32_t avn_duplex_playback_buffered_frames(const avn_duplex* duplex)
{
    return duplex == NULL || !duplex->playback_ring_initialized
        ? 0
        : ma_pcm_rb_available_read((ma_pcm_rb*)&duplex->playback_ring);
}

#define AVN_U64_GETTER(function_name, field_name) \
    uint64_t function_name(const avn_duplex* duplex) \
    { \
        return duplex == NULL \
            ? 0 \
            : atomic_load_explicit(&duplex->field_name, memory_order_relaxed); \
    }

AVN_U64_GETTER(avn_duplex_callback_count, callback_count)
AVN_U64_GETTER(avn_duplex_capture_received_frames, capture_received_frames)
AVN_U64_GETTER(avn_duplex_capture_read_frames, capture_read_frames)
AVN_U64_GETTER(avn_duplex_capture_dropped_frames, capture_dropped_frames)
AVN_U64_GETTER(avn_duplex_playback_submitted_frames, playback_submitted_frames)
AVN_U64_GETTER(avn_duplex_playback_written_frames, playback_written_frames)
AVN_U64_GETTER(avn_duplex_playback_dropped_frames, playback_dropped_frames)
AVN_U64_GETTER(avn_duplex_playback_rendered_frames, playback_rendered_frames)
AVN_U64_GETTER(avn_duplex_playback_starved_frames, playback_starved_frames)
AVN_U64_GETTER(avn_duplex_started_notifications, started_notifications)
AVN_U64_GETTER(avn_duplex_stopped_notifications, stopped_notifications)
AVN_U64_GETTER(avn_duplex_rerouted_notifications, rerouted_notifications)
AVN_U64_GETTER(
    avn_duplex_interruption_began_notifications,
    interruption_began_notifications
)
AVN_U64_GETTER(
    avn_duplex_interruption_ended_notifications,
    interruption_ended_notifications
)

uint64_t avn_duplex_playback_starvation_count(const avn_duplex* duplex)
{
    return duplex == NULL
        ? 0
        : atomic_load_explicit(&duplex->playback_starvation_count, memory_order_acquire);
}

uint32_t avn_duplex_playback_starvation_event_capacity(void)
{
    return AVN_PLAYBACK_STARVATION_EVENT_CAPACITY;
}

uint32_t avn_duplex_get_playback_starvation_event(
    const avn_duplex* duplex,
    uint64_t sequence,
    avn_playback_starvation_event* event
)
{
    if (duplex == NULL || sequence == 0 || event == NULL) {
        return 0;
    }
    const avn_playback_starvation_slot* slot = &duplex->playback_starvation_events[
        (sequence - 1) % AVN_PLAYBACK_STARVATION_EVENT_CAPACITY
    ];
    if (atomic_load_explicit(&slot->sequence, memory_order_acquire) != sequence) {
        return 0;
    }

    event->sequence = sequence;
    event->callback_count = atomic_load_explicit(
        &slot->callback_count,
        memory_order_relaxed
    );
    event->available_frames = atomic_load_explicit(
        &slot->available_frames,
        memory_order_relaxed
    );
    event->requested_frames = atomic_load_explicit(
        &slot->requested_frames,
        memory_order_relaxed
    );
    event->read_frames = atomic_load_explicit(&slot->read_frames, memory_order_relaxed);
    event->reserved = 0;

    return atomic_load_explicit(&slot->sequence, memory_order_acquire) == sequence;
}

uint32_t avn_duplex_max_callback_frames(const avn_duplex* duplex)
{
    return duplex == NULL
        ? 0
        : atomic_load_explicit(&duplex->max_callback_frames, memory_order_relaxed);
}
