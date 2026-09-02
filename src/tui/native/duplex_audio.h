#ifndef AGENTVOICE_DUPLEX_AUDIO_H
#define AGENTVOICE_DUPLEX_AUDIO_H

#include <stdint.h>

#if defined(_WIN32)
#define AVN_AUDIO_API __declspec(dllexport)
#elif defined(__GNUC__)
#define AVN_AUDIO_API __attribute__((visibility("default")))
#else
#define AVN_AUDIO_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct avn_duplex avn_duplex;

enum {
    AVN_DUPLEX_ABI_VERSION = 1,
    AVN_DUPLEX_SAMPLE_RATE = 48000,
    AVN_DUPLEX_CAPTURE_CHANNELS = 1,
    AVN_DUPLEX_PLAYBACK_CHANNELS = 2,
};

typedef struct {
    uint64_t sequence;
    uint64_t callback_count;
    uint32_t available_frames;
    uint32_t requested_frames;
    uint32_t read_frames;
    uint32_t reserved;
} avn_playback_starvation_event;

AVN_AUDIO_API uint32_t avn_duplex_abi_version(void);
AVN_AUDIO_API const char* avn_duplex_miniaudio_version(void);
AVN_AUDIO_API const char* avn_duplex_result_description(int32_t result);

AVN_AUDIO_API avn_duplex* avn_duplex_create(
    uint32_t capture_capacity_frames,
    uint32_t playback_capacity_frames,
    uint32_t playback_start_frames
);
AVN_AUDIO_API void avn_duplex_destroy(avn_duplex* duplex);

AVN_AUDIO_API uint32_t avn_duplex_capture_device_count(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_playback_device_count(const avn_duplex* duplex);
AVN_AUDIO_API const char* avn_duplex_capture_device_name(
    const avn_duplex* duplex,
    uint32_t index
);
AVN_AUDIO_API const char* avn_duplex_playback_device_name(
    const avn_duplex* duplex,
    uint32_t index
);
AVN_AUDIO_API uint32_t avn_duplex_capture_device_is_default(
    const avn_duplex* duplex,
    uint32_t index
);
AVN_AUDIO_API uint32_t avn_duplex_playback_device_is_default(
    const avn_duplex* duplex,
    uint32_t index
);

/* Negative device indices select the operating-system default. */
AVN_AUDIO_API int32_t avn_duplex_start(
    avn_duplex* duplex,
    int32_t capture_device_index,
    int32_t playback_device_index
);
AVN_AUDIO_API int32_t avn_duplex_stop(avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_is_started(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_device_state(const avn_duplex* duplex);

/* Capture is mono s16; playback is interleaved stereo s16, both at 48 kHz. */
AVN_AUDIO_API uint32_t avn_duplex_read_capture(
    avn_duplex* duplex,
    int16_t* frames,
    uint32_t frame_count
);
AVN_AUDIO_API uint32_t avn_duplex_write_playback(
    avn_duplex* duplex,
    const int16_t* frames,
    uint32_t frame_count
);
AVN_AUDIO_API void avn_duplex_clear_playback(avn_duplex* duplex);

AVN_AUDIO_API const char* avn_duplex_backend_name(const avn_duplex* duplex);
AVN_AUDIO_API const char* avn_duplex_active_capture_device_name(const avn_duplex* duplex);
AVN_AUDIO_API const char* avn_duplex_active_playback_device_name(const avn_duplex* duplex);
AVN_AUDIO_API const char* avn_duplex_capture_internal_format(const avn_duplex* duplex);
AVN_AUDIO_API const char* avn_duplex_playback_internal_format(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_capture_internal_sample_rate(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_playback_internal_sample_rate(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_capture_internal_channels(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_playback_internal_channels(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_capture_period_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_playback_period_frames(const avn_duplex* duplex);

AVN_AUDIO_API uint32_t avn_duplex_capture_buffered_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_playback_buffered_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_callback_count(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_max_callback_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_capture_received_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_capture_read_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_capture_dropped_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_playback_submitted_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_playback_written_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_playback_dropped_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_playback_rendered_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_playback_starvation_count(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_playback_starved_frames(const avn_duplex* duplex);
AVN_AUDIO_API uint32_t avn_duplex_playback_starvation_event_capacity(void);
AVN_AUDIO_API uint32_t avn_duplex_get_playback_starvation_event(
    const avn_duplex* duplex,
    uint64_t sequence,
    avn_playback_starvation_event* event
);
AVN_AUDIO_API uint64_t avn_duplex_started_notifications(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_stopped_notifications(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_rerouted_notifications(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_interruption_began_notifications(const avn_duplex* duplex);
AVN_AUDIO_API uint64_t avn_duplex_interruption_ended_notifications(const avn_duplex* duplex);

#ifdef __cplusplus
}
#endif

#endif
