package com.arthack.agentvoice

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
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

    @Test fun thinkingNarrowsOnlyDashPathsWhileKeepingCircleAndSweepAuthored() {
        val original = source()
        val sourceValues = ByteBuffer.wrap(original).order(ByteOrder.LITTLE_ENDIAN)
        val result = compactHaloBytes(original, CompactHaloTuning())
        val values = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN)
        val sites = listOf(304, 364, 436, 496)
        for (site in sites) {
            assertEquals(1.28f, sourceValues.getFloat(site), 0f)
            assertEquals(1.05f, values.getFloat(site), 0f)
        }
        // Whole static dash/frame object region, including all four Y extents and
        // the central frame ellipse: exactly the four intended scale fields differ.
        val allowed = sites.flatMap { it until it + 4 }.toSet()
        for (offset in 221 until 540) if (offset !in allowed)
            assertEquals("Unrelated shape byte $offset", original[offset], result[offset])
        assertEquals(128f, values.getFloat(243), 0f)
        assertEquals(128f, values.getFloat(248), 0f)
        // Both full trim-path loops and thinking_off retain their exact source bytes.
        assertArrayEquals(original.copyOfRange(1509, 1847), result.copyOfRange(1509, 1847))
    }
}
