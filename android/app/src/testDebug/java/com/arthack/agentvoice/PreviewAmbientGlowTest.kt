package com.arthack.agentvoice

import kotlin.math.abs
import kotlin.math.sqrt
import org.junit.Assert.*
import org.junit.Test

class PreviewAmbientGlowTest {
    private val ground = listOf(5f, 6f, 7f)
    private val representativePoints = listOf(.25f to .6f, .5f to .5f, .75f to .3f)

    @Test fun zeroAndInvalidAmountsHaveNoDrawingAndFullStrengthIsBounded() {
        for (amount in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertTrue(previewAmbientLobes(PreviewAmbientFrame(.3f, amount)).isEmpty())
            assertEquals(ground, sample(PreviewAmbientFrame(.3f, amount), .5f, .5f))
        }
        assertEquals(previewAmbientLobes(PreviewAmbientFrame(.3f, 1f)),
            previewAmbientLobes(PreviewAmbientFrame(.3f, 100f)))
    }

    @Test fun fieldsStayFiniteWithinSmallDriftAndSwellAndCannotMakeABrightBand() {
        val centers = listOf(.25f to .59f, .78f to .34f)
        val radii = listOf(.74f to .56f, .78f to .64f)
        for (step in -56..56) {
            val lobes = previewAmbientLobes(PreviewAmbientFrame(step / 28f, 1f))
            assertEquals(2, lobes.size)
            assertTrue(lobes.sumOf { it.alpha.toDouble() } <= .14)
            for ((index, lobe) in lobes.withIndex()) {
                assertTrue(listOf(lobe.centerX, lobe.centerY, lobe.radiusX, lobe.radiusY, lobe.alpha).all { it.isFinite() })
                assertTrue(abs(lobe.centerX - centers[index].first) <= .03001f)
                assertTrue(abs(lobe.centerY - centers[index].second) <= .03001f)
                assertTrue(abs(lobe.radiusX / radii[index].first - 1f) <= .06001f)
                assertTrue(abs(lobe.radiusY / radii[index].second - 1f) <= .06001f)
                assertTrue(lobe.alpha > 0f)
            }
        }
        assertEquals(0f to 1f, previewAmbientFeatherStops.first())
        assertEquals(1f to 0f, previewAmbientFeatherStops.last())
        for ((inner, outer) in previewAmbientFeatherStops.zipWithNext()) {
            assertTrue(outer.first > inner.first)
            assertTrue(outer.second < inner.second)
        }
    }

    @Test fun staticPhaseKeepsAVisibleDimFieldWithoutRequiringMotion() {
        val static = PreviewAmbientFrame(amount = 1f)
        for ((x, y) in representativePoints) {
            val lift = sample(static, x, y).zip(ground) { result, base -> result - base }
            assertTrue("Full-strength static field disappeared at $x, $y: $lift", lift.max() >= 10f)
            assertTrue("Full-strength static field overpowered the ground at $x, $y: $lift", lift.max() <= 25f)
            assertTrue(lift.all { it > 0f })
        }
        for (phase in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertEquals(previewAmbientLobes(static), previewAmbientLobes(PreviewAmbientFrame(phase, 1f)))
        }
    }

    @Test fun sixSecondsOfTheSharedCycleIsVisibleAndItsWrapIsContinuous() {
        val start = PreviewAmbientFrame(amount = 1f)
        val later = PreviewAmbientFrame(6f / 14f, 1f)
        for ((x, y) in representativePoints) {
            val change = sample(start, x, y).zip(sample(later, x, y)) { first, next -> abs(next - first) }
            assertTrue("Six seconds produced no visible change at $x, $y: $change", change.max() >= 4f)
            val seam = sample(PreviewAmbientFrame(.9999f, 1f), x, y)
                .zip(sample(PreviewAmbientFrame(.0001f, 1f), x, y)) { before, after -> abs(after - before) }
            assertTrue("The shared phase wrap flashed at $x, $y: $seam", seam.max() < .1f)
        }
        for (phase in listOf(0f, .125f, .5f, .875f)) {
            assertEquals(previewAmbientLobes(PreviewAmbientFrame(phase, 1f)),
                previewAmbientLobes(PreviewAmbientFrame(phase + 2f, 1f)))
            assertEquals(previewAmbientLobes(PreviewAmbientFrame(phase, 1f)),
                previewAmbientLobes(PreviewAmbientFrame(phase - 2f, 1f)))
        }
    }

    @Test fun strengthChangesBrightnessWithoutChangingGeometryOrReversingItsResponse() {
        val full = previewAmbientLobes(PreviewAmbientFrame(.3f, 1f))
        for ((x, y) in representativePoints) {
            var previous = ground
            for (amount in listOf(.1f, .25f, .5f, .75f, 1f)) {
                val frame = PreviewAmbientFrame(.3f, amount)
                val lobes = previewAmbientLobes(frame)
                assertEquals(full.map { it.copy(alpha = 0f) }, lobes.map { it.copy(alpha = 0f) })
                val next = sample(frame, x, y)
                assertTrue("Increasing strength darkened $x, $y", next.zip(previous).all { (new, old) -> new > old })
                previous = next
            }
        }
    }

    // Sample the renderer's normalized gradient stops with source-over on the exact studio ground.
    private fun sample(frame: PreviewAmbientFrame, x: Float, y: Float): List<Float> {
        var result = ground
        for (lobe in previewAmbientLobes(frame)) {
            val dx = (x - lobe.centerX) / lobe.radiusX
            val dy = (y - lobe.centerY) / lobe.radiusY
            val radius = sqrt(dx * dx + dy * dy)
            if (radius >= 1f) continue
            val (inner, outer) = previewAmbientFeatherStops.zipWithNext().first { radius <= it.second.first }
            val fraction = (radius - inner.first) / (outer.first - inner.first)
            val alpha = lobe.alpha * (inner.second + (outer.second - inner.second) * fraction)
            val tint = listOf(16, 8, 0).map { ((lobe.tint ushr it) and 255).toFloat() }
            result = result.zip(tint) { base, color -> base + (color - base) * alpha }
        }
        return result
    }
}
