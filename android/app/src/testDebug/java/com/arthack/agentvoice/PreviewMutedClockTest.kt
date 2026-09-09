package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewMutedClockTest {
    @Test fun changingCyclePreservesPhaseAndDoesNotRetuneTheOtherSceneMotion() {
        val motion = PreviewSpiritMotion()
        val ui = CallUi(connected = true, micMuted = true, speakerMuted = true)
        fun step(dt: Float, cycle: Int, allowed: Boolean = true) = motion.step(ui,
            PreviewSpirit("soft", 50, "fixed"), CompactHaloColors(), false, "steady", dt, allowed, 100, true, cycle)
        repeat(40) { step(.1f, 14) }
        val before = step(0f, 14)
        val changed = step(0f, 6)
        assertEquals(before.phaseTurns, changed.phaseTurns)
        assertEquals(before.ambient.phaseTurns, changed.ambient.phaseTurns)
        val faster = step(.1f, 6)
        assertEquals(.1f / 6, faster.phaseTurns - changed.phaseTurns, .00001f)
        assertEquals(.1f / 14, faster.ambient.phaseTurns - changed.ambient.phaseTurns, .00001f)
        assertEquals(0f, step(.1f, 6, false).phaseTurns)
        assertEquals(faster.phaseTurns, step(0f, 30).phaseTurns)
    }

    @Test fun compressedContainedMotionReservesLessSpaceAndOriginalIsUnchanged() {
        val normal = PreviewHalo(variant = "contained")
        val still = normal.copy(ringSpreadPercent = 0, listeningPulsePercent = 0, speakingMotionPercent = 0, idleBreathingPercent = 0)
        val compressed = normal.copy(ringSpreadPercent = 100, listeningPulsePercent = 100, speakingMotionPercent = 100, idleBreathingPercent = 100)
        assertTrue(previewMutedApertureFactor(still) > previewMutedApertureFactor(normal))
        assertTrue(previewMutedApertureFactor(normal) > previewMutedApertureFactor(compressed))
        assertTrue(previewMutedApertureFactor(compressed) > 0f)
        assertEquals(.16f, previewMutedApertureFactor(compressed.copy(variant = "original")))
    }
}
