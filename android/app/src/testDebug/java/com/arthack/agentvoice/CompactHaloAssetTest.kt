package com.arthack.agentvoice

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class CompactHaloAssetTest {
    private fun source() = File("src/main/res/raw/persona_halo.riv").readBytes()

    @Test fun rejectsAnyDifferentSourceWithoutMutatingIt() {
        val original = source()
        val before = original.copyOf()
        val altered = compactHaloBytes(original, CompactHaloTuning())
        assertArrayEquals(before, original)
        assertFalse(altered.contentEquals(original))
        assertArrayEquals(altered, compactHaloBytes(original, CompactHaloTuning()))
        val corrupted = original.copyOf().also { it[2000] = (it[2000].toInt() xor 1).toByte() }
        val failure = runCatching { compactHaloBytes(corrupted, CompactHaloTuning()) }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertTrue(failure!!.message!!.contains("Choose Original"))
        assertTrue(runCatching { compactHaloBytes(original.copyOf(100), CompactHaloTuning()) }.isFailure)
    }

    @Test fun rangeLimitsAreEnforcedBeforeBuildingASource() {
        assertTrue(runCatching { CompactHaloTuning(ringSpreadPercent = -1) }.isFailure)
        assertTrue(runCatching { CompactHaloTuning(listeningPulsePercent = 101) }.isFailure)
        assertTrue(runCatching { CompactHaloTuning(speakingMotionPercent = Int.MAX_VALUE) }.isFailure)
        assertTrue(runCatching { CompactHaloTuning(idleBreathingPercent = -1) }.isFailure)
        for (value in listOf(0, 100)) {
            val bytes = compactHaloBytes(source(), CompactHaloTuning(value, value, value, value))
            assertEquals(4497, bytes.size)
            assertEquals("RIVE", bytes.copyOfRange(0, 4).toString(Charsets.US_ASCII))
        }
    }
}
