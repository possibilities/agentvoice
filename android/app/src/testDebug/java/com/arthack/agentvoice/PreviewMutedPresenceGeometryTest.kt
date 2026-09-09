package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

class PreviewMutedPresenceGeometryTest {
    @Test fun roomyApertureKeepsTheRequestedTide() {
        val fit = previewMutedPresenceFit(44f, 18f, 40f)!!
        assertEquals(1f, fit.driftXPx, .0001f)
        assertEquals(3f, fit.driftYPx, .0001f)
        assertEveryPhaseFits(44f, 18f, 40f, 1f, fit)
    }

    @Test fun tightApertureReducesDriftTogetherWithoutShrinkingText() {
        val fit = previewMutedPresenceFit(44f, 18f, 33f)!!
        assertTrue(fit.driftXPx > 0f && fit.driftXPx < 1f)
        assertEquals(fit.driftXPx * 3f, fit.driftYPx, .0001f)
        assertEveryPhaseFits(44f, 18f, 33f, 1f, fit)
        assertTrue(hypot((22f + fit.driftXPx).toDouble(), (9f + fit.driftYPx).toDouble()) + 8.0 <= 33.0001)
    }

    @Test fun exactStillFitKeepsEightDpClearanceAndRemovesAllDrift() {
        // Half of this 48 x 14 rectangle is a 7-24-25 right triangle.
        val fit = previewMutedPresenceFit(48f, 14f, 33f)!!
        assertEquals(0f, fit.driftXPx, 0f)
        assertEquals(0f, fit.driftYPx, 0f)
        assertNull(previewMutedPresenceFit(48f, 14f, 32.99f))
    }

    @Test fun densityChangesPreservePhysicalClearanceAndMotion() {
        val reference = previewMutedPresenceFit(44f, 18f, 33f)!!
        for (unit in listOf(.75f, 1f, 2.625f, 3f)) {
            val fit = previewMutedPresenceFit(44f * unit, 18f * unit, 33f * unit, unit)!!
            assertEquals(reference.driftXPx * unit, fit.driftXPx, .0001f)
            assertEquals(reference.driftYPx * unit, fit.driftYPx, .0001f)
            assertEveryPhaseFits(44f * unit, 18f * unit, 33f * unit, unit, fit)
        }
    }

    @Test fun conservativeContainedEnvelopeFitsNormalTextAndOmitsImpossibleSizes() {
        fun aperture(scale: Float) = .07f * 360f * 1.9f * scale
        val normal = previewMutedPresenceFit(44f, 18f, aperture(.78f))!!
        assertEquals(PreviewMutedPresenceFit(1f, 3f), normal)
        assertNull(previewMutedPresenceFit(44f, 18f, aperture(.35f)))
        assertNull(previewMutedPresenceFit(66f, 27f, aperture(.78f)))
    }

    @Test fun invalidDimensionsCannotCreateDrawingCoordinates() {
        for (invalid in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertNull(previewMutedPresenceFit(invalid, 18f, 40f))
            assertNull(previewMutedPresenceFit(44f, invalid, 40f))
            assertNull(previewMutedPresenceFit(44f, 18f, invalid))
            assertNull(previewMutedPresenceFit(44f, 18f, 40f, invalid))
        }
        assertNull(previewMutedPresenceFit(44f, 18f, 8f))
    }

    private fun assertEveryPhaseFits(width: Float, height: Float, radius: Float, unit: Float,
        fit: PreviewMutedPresenceFit) {
        for (step in 0..360) {
            val angle = step / 360.0 * 2.0 * PI
            val x = fit.driftXPx * sin(angle)
            val y = fit.driftYPx * cos(angle)
            for (side in listOf(-1, 1)) for (edge in listOf(-1, 1)) {
                val corner = hypot(x + side * width / 2.0, y + edge * height / 2.0)
                assertTrue("The word and 8 dp clearance must fit at phase $step", corner + 8.0 * unit <= radius + .0001)
            }
        }
    }
}
