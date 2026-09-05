/* Memory-only regression for the actual native playback callback. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../src/console/native/duplex_audio.c"

enum {
    CALLBACK_FRAMES = 480,
    PACKET_FRAMES = 960,
    START_FRAMES = 24000,
    RECOVERY_FRAMES = 1920,
    LARGE_CALLBACK_FRAMES = 3840,
    RING_FRAMES = 48000,
};

static void init_fake(avn_duplex* duplex)
{
    memset(duplex, 0, sizeof(*duplex));
    avn_init_atomics(duplex);
    duplex->playback_start_frames = START_FRAMES;
    duplex->playback_recovery_frames = RECOVERY_FRAMES;
    assert(ma_pcm_rb_init(
               ma_format_s16,
               AVN_DUPLEX_PLAYBACK_CHANNELS,
               RING_FRAMES,
               NULL,
               NULL,
               &duplex->playback_ring
           ) == MA_SUCCESS);
    duplex->playback_ring_initialized = true;
    duplex->device.pUserData = duplex;
    /* This only makes clear_playback use its callback-safe path; no device is initialized. */
    duplex->device_initialized = true;
}

static void destroy_fake(avn_duplex* duplex)
{
    ma_pcm_rb_uninit(&duplex->playback_ring);
}

static void feed_sequence(avn_duplex* duplex, uint32_t frames, int16_t* next)
{
    int16_t pcm[PACKET_FRAMES * AVN_DUPLEX_PLAYBACK_CHANNELS];
    while (frames > 0) {
        uint32_t chunk = frames < PACKET_FRAMES ? frames : PACKET_FRAMES;
        for (uint32_t index = 0; index < chunk; index += 1) {
            pcm[index * AVN_DUPLEX_PLAYBACK_CHANNELS] = *next;
            pcm[index * AVN_DUPLEX_PLAYBACK_CHANNELS + 1] = *next;
            *next += 1;
        }
        assert(avn_ring_write(
                   &duplex->playback_ring,
                   pcm,
                   chunk,
                   AVN_DUPLEX_PLAYBACK_CHANNELS * sizeof(int16_t)
               ) == chunk);
        frames -= chunk;
    }
}

static void tick_frames(avn_duplex* duplex, int16_t* output, uint32_t frame_count)
{
    memset(output, 0x7f, (size_t)frame_count * AVN_DUPLEX_PLAYBACK_CHANNELS * sizeof(int16_t));
    avn_data_callback(&duplex->device, output, NULL, frame_count);
}

static void tick(avn_duplex* duplex, int16_t output[CALLBACK_FRAMES * AVN_DUPLEX_PLAYBACK_CHANNELS])
{
    tick_frames(duplex, output, CALLBACK_FRAMES);
}

static void expect_silence(avn_duplex* duplex)
{
    int16_t output[CALLBACK_FRAMES * AVN_DUPLEX_PLAYBACK_CHANNELS];
    tick(duplex, output);
    for (uint32_t index = 0; index < CALLBACK_FRAMES * AVN_DUPLEX_PLAYBACK_CHANNELS; index += 1) {
        assert(output[index] == 0);
    }
}

static void expect_sequence(avn_duplex* duplex, uint32_t frames, int16_t* next)
{
    int16_t output[CALLBACK_FRAMES * AVN_DUPLEX_PLAYBACK_CHANNELS];
    assert(frames <= CALLBACK_FRAMES);
    tick(duplex, output);
    for (uint32_t index = 0; index < frames; index += 1) {
        assert(output[index * AVN_DUPLEX_PLAYBACK_CHANNELS] == *next);
        assert(output[index * AVN_DUPLEX_PLAYBACK_CHANNELS + 1] == *next);
        *next += 1;
    }
    for (uint32_t index = frames; index < CALLBACK_FRAMES; index += 1) {
        assert(output[index * AVN_DUPLEX_PLAYBACK_CHANNELS] == 0);
        assert(output[index * AVN_DUPLEX_PLAYBACK_CHANNELS + 1] == 0);
    }
}

static void test_initial_priming(void)
{
    avn_duplex duplex;
    int16_t feed_next = 100;
    int16_t render_next = 100;
    init_fake(&duplex);

    feed_sequence(&duplex, 9600, &feed_next);
    for (uint32_t callback = 0; callback < 200; callback += 1) {
        expect_silence(&duplex);
    }
    assert(ma_pcm_rb_available_read(&duplex.playback_ring) == 9600);

    feed_sequence(&duplex, START_FRAMES - 9600, &feed_next);
    expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    destroy_fake(&duplex);
}

static void test_recovery_after_underrun(void)
{
    avn_duplex duplex;
    int16_t feed_next = 100;
    int16_t render_next = 100;
    init_fake(&duplex);

    feed_sequence(&duplex, START_FRAMES, &feed_next);
    for (uint32_t callback = 0; callback < START_FRAMES / CALLBACK_FRAMES; callback += 1) {
        expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    }
    expect_silence(&duplex);
    assert(atomic_load(&duplex.playback_starvation_count) == 1);
    assert(atomic_load(&duplex.playback_starved_frames) == CALLBACK_FRAMES);

    /* Returning 20 ms packets must restart after two packets, not wait for 500 ms. */
    feed_sequence(&duplex, PACKET_FRAMES, &feed_next);
    expect_silence(&duplex);
    expect_silence(&duplex);
    feed_sequence(&duplex, PACKET_FRAMES, &feed_next);
    expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    assert(atomic_load(&duplex.playback_starvation_count) == 1);
    assert(atomic_load(&duplex.playback_starved_frames) == CALLBACK_FRAMES);

    for (uint32_t callback = 3; callback < 100; callback += 1) {
        if (callback % 2 == 0) {
            feed_sequence(&duplex, PACKET_FRAMES, &feed_next);
        }
        expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    }
    assert(atomic_load(&duplex.playback_starvation_count) == 1);
    destroy_fake(&duplex);
}

static void test_partial_underrun(void)
{
    avn_duplex duplex;
    int16_t feed_next = 100;
    int16_t render_next = 100;
    init_fake(&duplex);

    feed_sequence(&duplex, START_FRAMES + CALLBACK_FRAMES / 2, &feed_next);
    for (uint32_t callback = 0; callback < START_FRAMES / CALLBACK_FRAMES; callback += 1) {
        expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    }
    expect_sequence(&duplex, CALLBACK_FRAMES / 2, &render_next);
    assert(atomic_load(&duplex.playback_starvation_count) == 1);
    assert(atomic_load(&duplex.playback_starved_frames) == CALLBACK_FRAMES / 2);

    feed_sequence(&duplex, PACKET_FRAMES, &feed_next);
    expect_silence(&duplex);
    feed_sequence(&duplex, PACKET_FRAMES, &feed_next);
    expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    destroy_fake(&duplex);
}

static void test_large_callback_recovery(void)
{
    avn_duplex duplex;
    int16_t feed_next = 100;
    int16_t render_next = 100;
    int16_t output[LARGE_CALLBACK_FRAMES * AVN_DUPLEX_PLAYBACK_CHANNELS];
    init_fake(&duplex);

    feed_sequence(&duplex, START_FRAMES, &feed_next);
    for (uint32_t callback = 0; callback < START_FRAMES / CALLBACK_FRAMES; callback += 1) {
        expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    }
    expect_silence(&duplex);
    assert(atomic_load(&duplex.playback_starvation_count) == 1);

    feed_sequence(&duplex, RECOVERY_FRAMES, &feed_next);
    tick_frames(&duplex, output, LARGE_CALLBACK_FRAMES);
    for (uint32_t index = 0;
         index < LARGE_CALLBACK_FRAMES * AVN_DUPLEX_PLAYBACK_CHANNELS;
         index += 1) {
        assert(output[index] == 0);
    }

    feed_sequence(&duplex, LARGE_CALLBACK_FRAMES - RECOVERY_FRAMES, &feed_next);
    tick_frames(&duplex, output, LARGE_CALLBACK_FRAMES);
    for (uint32_t index = 0; index < LARGE_CALLBACK_FRAMES; index += 1) {
        assert(output[index * AVN_DUPLEX_PLAYBACK_CHANNELS] == render_next);
        assert(output[index * AVN_DUPLEX_PLAYBACK_CHANNELS + 1] == render_next);
        render_next += 1;
    }
    assert(atomic_load(&duplex.playback_starvation_count) == 1);
    destroy_fake(&duplex);
}

static void test_clear_resets_to_startup_priming(void)
{
    avn_duplex duplex;
    int16_t feed_next = 100;
    int16_t render_next = 100;
    init_fake(&duplex);

    feed_sequence(&duplex, START_FRAMES, &feed_next);
    expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    avn_duplex_clear_playback(&duplex);
    expect_silence(&duplex);

    render_next = feed_next;
    feed_sequence(&duplex, RECOVERY_FRAMES, &feed_next);
    expect_silence(&duplex);
    feed_sequence(&duplex, START_FRAMES - RECOVERY_FRAMES, &feed_next);
    expect_sequence(&duplex, CALLBACK_FRAMES, &render_next);
    destroy_fake(&duplex);
}

int main(void)
{
    test_initial_priming();
    test_recovery_after_underrun();
    test_partial_underrun();
    test_large_callback_recovery();
    test_clear_resets_to_startup_priming();
    puts("native playback callback regression: PASS");
    return 0;
}
