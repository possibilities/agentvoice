package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewMutedTuningTest {
    @Test fun defaultFramePreservesTheOriginalWholeWordTide() {
        val tuning = PreviewMutedTuning()
        assertEquals(PreviewMutedTuning(14, 0, 100, 0, 14, "float"), tuning)
        val fit = previewMutedPresenceFit(44f, 18f, 40f)!!
        val phases = listOf(0f, .25f, .5f, .75f, 1f)
        val x = listOf(0f, 1f, 0f, -1f, 0f)
        val y = listOf(3f, 0f, -3f, 0f, 3f)
        phases.forEachIndexed { index, phase ->
            val frame = previewMutedPresenceFrame(phase, true, fit)
            assertEquals(x[index], frame.offsetX, .0001f)
            assertEquals(y[index], frame.offsetY, .0001f)
            assertEquals(1f, frame.scale, 0f)
            assertEquals(.84f, frame.alpha, 0f)
            assertTrue(frame.glyphOffsets.isEmpty())
        }
    }

    @Test fun rippleTravelsAcrossTheLettersWithinTheRequestedAmplitude() {
        val tuning = PreviewMutedTuning(driftPercent = 300, breathPercent = 100, motion = "ripple")
        val fit = previewMutedPresenceFit(44f, 18f, 80f, tuning = tuning)!!
        val first = previewMutedPresenceFrame(0f, true, fit, tuning)
        assertEquals(5, first.glyphOffsets.size)
        assertTrue(first.glyphOffsets.toSet().size > 3)
        assertNotEquals(first.glyphOffsets, previewMutedPresenceFrame(.5f, true, fit, tuning).glyphOffsets)
        for (step in 0..360) {
            val frame = previewMutedPresenceFrame(step / 360f, true, fit, tuning)
            assertTrue(frame.offsetX in -3f..3f)
            assertTrue(frame.offsetY in -9f..9f)
            assertTrue(frame.glyphOffsets.all { it in -6f..6f })
            assertTrue(frame.scale in 1f..1.03f)
            assertTrue(frame.alpha in .84f..1f)
        }
    }

    @Test fun breathingRemainsReadableAtBothBrightnessEndpoints() {
        for (brightness in listOf(0, 100)) {
            val tuning = PreviewMutedTuning(brightnessPercent = brightness, breathPercent = 100)
            val fit = previewMutedPresenceFit(44f, 18f, 40f, tuning = tuning)!!
            val frames = (0..360).map { previewMutedPresenceFrame(it / 360f, true, fit, tuning) }
            assertTrue(frames.minOf { it.alpha } >= .84f)
            assertTrue(frames.maxOf { it.alpha } <= 1f)
            assertEquals(.15f, frames.maxOf { it.alpha } - frames.minOf { it.alpha }, .0001f)
            assertEquals(1.03f, frames.maxOf { it.scale }, .0001f)
        }
    }

    @Test fun reducedMotionAndInvalidPhaseNeverModulateTheSelectedAppearance() {
        val tuning = PreviewMutedTuning(32, 100, 300, 100, 6, "ripple")
        val fit = previewMutedPresenceFit(100f, 42f, 88f, tuning = tuning)!!
        val still = PreviewMutedPresenceFrame(alpha = 1f)
        for (phase in listOf(0f, .25f, .5f, .75f, 1f, Float.NaN, Float.POSITIVE_INFINITY)) {
            assertEquals(still, previewMutedPresenceFrame(phase, false, fit, tuning))
        }
        assertEquals(still, previewMutedPresenceFrame(Float.NaN, true, fit, tuning))
        assertEquals(still, previewMutedPresenceFrame(Float.POSITIVE_INFINITY, true, fit, tuning))
    }

    @Test fun negativeBrightnessDimsTheWholeBreathWithoutRaisingItsFloor() {
        val base = PreviewMutedTuning(breathPercent = 100)
        val fit = previewMutedPresenceFit(44f, 18f, 40f, tuning = base)!!
        for (phase in listOf(0f, .25f, .5f, .75f)) {
            val original = previewMutedPresenceFrame(phase, true, fit, base)
            val dimmed = previewMutedPresenceFrame(phase, true, fit, base.copy(brightnessPercent = -75))
            assertEquals(original.alpha * .25f, dimmed.alpha, .0001f)
            assertEquals(original.offsetY, dimmed.offsetY, 0f)
            assertEquals(0f, previewMutedPresenceFrame(phase, true, fit, base.copy(brightnessPercent = -100)).alpha, 0f)
        }
        assertEquals(.21f, previewMutedPresenceFrame(0f, false, fit, base.copy(brightnessPercent = -75)).alpha, .0001f)
    }

    @Test fun cycleSelectionDoesNotReinterpretTheAlreadyIntegratedPhase() {
        val tuning = PreviewMutedTuning()
        val fit = previewMutedPresenceFit(44f, 18f, 40f)!!
        val frame = previewMutedPresenceFrame(.37f, true, fit, tuning)
        for (seconds in listOf(6, 14, 30)) {
            assertEquals(frame, previewMutedPresenceFrame(.37f, true, fit, tuning.copy(cycleSeconds = seconds)))
        }
    }

    @Test fun controlBoundsAreStrictAndBothEndpointsRemainSelectable() {
        PreviewMutedTuning(12, 0, 0, 0, 6, "float")
        PreviewMutedTuning(32, 100, 300, 100, 30, "ripple")
        for (value in listOf(11, 33)) assertThrows(IllegalArgumentException::class.java) { PreviewMutedTuning(textSizeSp = value) }
        for (value in listOf(-1, 101)) {
            assertThrows(IllegalArgumentException::class.java) { PreviewMutedTuning(breathPercent = value) }
        }
        for (value in listOf(-101, 101)) assertThrows(IllegalArgumentException::class.java) { PreviewMutedTuning(brightnessPercent = value) }
        for (value in listOf(-1, 301)) assertThrows(IllegalArgumentException::class.java) { PreviewMutedTuning(driftPercent = value) }
        for (value in listOf(5, 31)) assertThrows(IllegalArgumentException::class.java) { PreviewMutedTuning(cycleSeconds = value) }
        for (value in listOf("", "Float", "orbit")) assertThrows(IllegalArgumentException::class.java) { PreviewMutedTuning(motion = value) }
    }
}
