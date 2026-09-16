package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewTraceEnergyTest {
    @Test fun captureMovesTowardPersonaWhilePlaybackMovesTowardControl() {
        fun centroid(phase: Float, channel: PreviewTraceChannel): Float {
            val samples = (0..100).map { it / 100f }
            return samples.sumOf { (it * previewTraceFlowAt(it, phase, channel)).toDouble() }.toFloat() /
                samples.sumOf { previewTraceFlowAt(it, phase, channel).toDouble() }.toFloat()
        }
        val capture = PreviewTraceChannel.Capture
        val playback = PreviewTraceChannel.Playback
        assertTrue(centroid(.3f, capture) > centroid(.6f, capture))
        assertTrue(centroid(.3f, playback) < centroid(.6f, playback))
        for (phase in listOf(0f, .25f, .5f, .75f, 1f)) for (index in 0..100) {
            val position = index / 100f
            assertEquals(previewTraceFlowAt(position, phase, capture),
                previewTraceFlowAt(1f - position, phase, playback), .00001f)
            if (phase == 0f || phase == 1f) assertEquals(0f, previewTraceFlowAt(position, phase, capture), .00001f)
        }
    }

    @Test fun currentGatesFenceAStaleDrawFrameWithoutWaitingForTheClock() {
        val light = PreviewButtonLight(captureEnergy = 1f, playbackEnergy = .5f)
        val ui = CallUi(connected = true, micOpen = true, speakerOpen = true)
        assertEquals(1f, light.traceEnergy(PreviewTraceChannel.Capture, ui))
        assertEquals(.5f, light.traceEnergy(PreviewTraceChannel.Playback, ui))
        assertEquals(0f, light.traceEnergy(PreviewTraceChannel.Capture, ui.copy(micOpen = false)))
        assertEquals(0f, light.traceEnergy(PreviewTraceChannel.Playback, ui.copy(speakerOpen = false)))
        for (closed in listOf(ui.copy(connected = false), ui.copy(controlsPending = true))) {
            for (channel in PreviewTraceChannel.entries) assertEquals(0f, light.traceEnergy(channel, closed))
        }
        assertEquals(0f, light.copy(captureEnergy = Float.NaN).traceEnergy(PreviewTraceChannel.Capture, ui))
    }
}
