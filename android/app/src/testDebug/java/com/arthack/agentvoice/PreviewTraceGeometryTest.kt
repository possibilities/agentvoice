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
