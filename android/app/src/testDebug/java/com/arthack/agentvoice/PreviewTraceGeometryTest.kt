package com.arthack.agentvoice

import kotlin.math.abs
import kotlin.math.hypot
import org.junit.Assert.*
import org.junit.Test

class PreviewTraceGeometryTest {
    private val patterns = listOf("parallel", "splayed", "circuit")

    @Test fun smallAndRaisedPersonaPortsStayAttachedToTheirAllocatedAperture() {
        for (pattern in patterns) {
            val settings = PreviewTraces(pattern = pattern)
            val small = geometry(radius = 55f, centerY = 280f, settings = settings)!!
            val raised = geometry(radius = 55f, centerY = 140f, settings = settings)!!
            val large = geometry(radius = 135f, centerY = 280f, settings = settings)!!
            assertTrue(small.routes.isNotEmpty())
            for ((index, trace) in small.routes.withIndex()) {
                assertEquals(55f, distance(trace.port, 196f, 280f), .001f)
                assertEquals(trace.port, trace.points.first())
                assertEquals(trace.landing, trace.points.last())
                assertTrue("Small Persona must not leave its contact at deckTop − 56", trace.port.y < small.deckTop - 100f)
                assertEquals(trace.port.x, raised.routes[index].port.x, .001f)
                assertEquals(trace.port.y - 140f, raised.routes[index].port.y, .001f)
                assertTrue(large.routes[index].port.y > trace.port.y)
            }
        }
    }

    @Test fun overlapCollapsesWithoutInvertingOrEnteringTheClearCenter() {
        for (pattern in patterns) {
            val settings = PreviewTraces(pattern = pattern, weightPercent = 250)
            assertTrue(geometry(stage = 400f, centerY = 420f, radius = 90f, settings = settings)!!.routes.isEmpty())
            for (radius in listOf(0f, 1f, 60f, 180f, 320f)) {
                for (centerY in listOf(-100f, 200f, 305f, 440f)) {
                    val result = geometry(stage = 400f, centerY = centerY, radius = radius, settings = settings)!!
                    for (trace in result.routes) {
                        for (point in trace.points) {
                            assertTrue(point.x.isFinite() && point.y.isFinite())
                            assertTrue(point.x in 0f..392f)
                            assertTrue(point.y <= result.endY)
                            assertTrue(distance(point, 196f, centerY) + .001f >= radius)
                        }
                        for ((previous, next) in trace.points.zipWithNext()) {
                            assertTrue("Routes never climb back toward an overlapping aperture", next.y >= previous.y)
                            assertTrue(abs(next.x - 196f) + .001f >= abs(previous.x - 196f))
                        }
                        assertEquals(result.endY, trace.landing.y, .001f)
                    }
                }
            }
        }
    }

    @Test fun stanceAndWeightRemainInsideTheirControlLandingsAtEveryDensity() {
        for (pattern in patterns) for (unit in listOf(1f, 2f, 3.5f)) {
            val narrow = geometry(unit = unit, settings = PreviewTraces(pattern = pattern, stancePercent = 75, weightPercent = 50))!!
            val wide = geometry(unit = unit, settings = PreviewTraces(pattern = pattern, stancePercent = 150, weightPercent = 250))!!
            assertEquals(.6f * unit, narrow.strokeWidth, .001f)
            assertEquals(3f * unit, wide.strokeWidth, .001f)
            for ((index, trace) in wide.routes.withIndex()) {
                val distance = abs(trace.landing.x - 196f * unit)
                assertTrue(distance > abs(narrow.routes[index].landing.x - 196f * unit))
                assertTrue(distance > 5f * unit + wide.contactWidth / 2f)
                assertTrue(distance + wide.contactWidth / 2f < (196f - 24f) * unit)
            }
        }
    }

    @Test fun offshootOpacityAndAmbientGlowDoNotMoveAnyRoutes() {
        for (pattern in patterns) {
            val settings = PreviewTraces(pattern = pattern)
            val still = geometry(settings = settings)!!
            val lit = geometry(settings = settings.copy(offshootPercent = 100, glowPercent = 100))!!
            assertTrue("Each pattern has independent side and upward branches", still.offshoots.isNotEmpty())
            assertEquals(still, lit)
            for (point in still.offshoots.flatten()) {
                assertTrue(point.x.isFinite() && point.y.isFinite())
                assertTrue(point.x in 0f..392f && point.y in 0f..still.deckTop)
                assertTrue(distance(point, 196f, 280f) + .001f >= 55f)
            }
        }
    }

    @Test fun endSpacingIsIndependentAndStanceNeverSqueezesFeet() {
        for (pattern in patterns) for (unit in listOf(1f, 3f)) {
            val base = PreviewTraces(pattern = pattern)
            val original = geometry(unit = unit, settings = base)!!
            val expectedFractions = if (pattern == "splayed") listOf(.16f, .29f, .42f) else listOf(.22f, .36f)
            for ((index, fraction) in expectedFractions.withIndex()) {
                assertEquals("100% preserves the previous contacts", 55f * unit * fraction,
                    abs(original.routes[index].port.x - 196f * unit), .001f)
            }
            for (spacing in listOf(50, 100, 200)) {
                val top = geometry(unit = unit, settings = base.copy(personaSpacingPercent = spacing))!!
                val feet = geometry(unit = unit, settings = base.copy(footSpacingPercent = spacing))!!
                assertEquals(original.routes.map { it.landing }, top.routes.map { it.landing })
                assertEquals(original.routes.map { it.port }, feet.routes.map { it.port })
                val topGap = abs(top.routes[1].port.x - top.routes[0].port.x)
                val oldGap = abs(original.routes[1].port.x - original.routes[0].port.x)
                assertEquals(oldGap * spacing / 100f, topGap, .001f)
                for (stance in listOf(75, 100, 150)) {
                    val selected = geometry(unit = unit, settings = base.copy(stancePercent = stance, footSpacingPercent = spacing))!!
                    val lanes = selected.routes.take(expectedFractions.size)
                    for ((a, b) in lanes.zipWithNext()) {
                        assertEquals("Foot spacing must survive stance changes", 8f * unit * spacing / 100f,
                            abs(a.landing.x - b.landing.x), .001f)
                    }
                }
            }
        }
    }

    @Test fun oppositeSpacingExtremesAndClampedAperturesDoNotCrossRoutes() {
        for (pattern in patterns) for (radius in listOf(1f, 55f, 135f, 320f)) {
            for (top in listOf(50, 200)) for (feet in listOf(50, 200)) for (stance in listOf(75, 150)) {
                val settings = PreviewTraces(pattern = pattern, stancePercent = stance,
                    personaSpacingPercent = top, footSpacingPercent = feet)
                val result = geometry(radius = radius, centerY = 140f, settings = settings)!!
                for (route in result.routes) {
                    for (point in route.points) {
                        assertTrue(distance(point, 196f, 140f) + .001f >= radius)
                        assertTrue(point.x in 0f..392f)
                    }
                    for ((a, b) in route.points.zipWithNext()) {
                        assertTrue(b.y >= a.y && abs(b.x - 196f) + .001f >= abs(a.x - 196f))
                    }
                }
                for ((i, a) in result.routes.withIndex()) for (b in result.routes.drop(i + 1)) {
                    for ((p, q) in a.points.zipWithNext()) for ((r, s) in b.points.zipWithNext()) {
                        fun orientation(a: PreviewTracePoint, b: PreviewTracePoint, c: PreviewTracePoint): Double =
                            (b.x - a.x).toDouble() * (c.y - a.y) - (b.y - a.y).toDouble() * (c.x - a.x)
                        val crosses = orientation(p, q, r) * orientation(p, q, s) < -1e-6 &&
                            orientation(r, s, p) * orientation(r, s, q) < -1e-6
                        assertFalse("$settings radius $radius crossed routes", crosses)
                    }
                }
            }
        }
        // Clearance can cap upper contacts at a large aperture; it never squeezes the requested feet.
        val capped = geometry(radius = 320f, centerY = 140f,
            settings = PreviewTraces(stancePercent = 75, personaSpacingPercent = 200, footSpacingPercent = 50))!!
        for (route in capped.routes) assertTrue(abs(route.port.x - 196f) <= abs(route.landing.x - 196f) - 4f + .001f)
    }

    @Test fun invalidOrMissingDrawingSpaceProducesNoGeometry() {
        assertNull(geometry(stage = Float.NaN))
        assertNull(geometry(centerY = Float.POSITIVE_INFINITY))
        assertNull(geometry(radius = -1f))
        assertNull(geometry(unit = 0f))
        assertNull(previewTraceGeometry(20f, 844f, 554f, 262f, 24f, 280f, 55f, 1f))
        assertNull(previewTraceGeometry(392f, 200f, 554f, 262f, 24f, 280f, 55f, 1f))
    }

    private fun geometry(stage: Float = 554f, centerY: Float = 280f, radius: Float = 55f,
        unit: Float = 1f, settings: PreviewTraces = PreviewTraces()): PreviewTraceGeometry? =
        previewTraceGeometry(392f * unit, 844f * unit, stage * unit, 262f * unit, 24f * unit,
            centerY * unit, radius * unit, unit, settings)

    private fun distance(point: PreviewTracePoint, centerX: Float, centerY: Float): Float =
        hypot((point.x - centerX).toDouble(), (point.y - centerY).toDouble()).toFloat()
}
