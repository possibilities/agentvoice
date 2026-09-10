package com.arthack.agentvoice

import kotlin.math.hypot
import org.junit.Assert.*
import org.junit.Test

class PreviewLandscapeTraceGeometryTest {
    @Test fun landscapeIsThePortraitEngineTurnedOntoTheNearMuteEdges() {
        for (unit in listOf(1f, 2f, 3.5f)) for (side in listOf("left", "right")) {
            for (pattern in listOf("parallel", "splayed", "circuit")) {
                val layout = layout(side)
                val settings = PreviewTraces(pattern = pattern, stancePercent = 130, weightPercent = 175,
                    personaSpacingPercent = 180, footSpacingPercent = 160)
                val actual = previewLandscapeTraceGeometry(layout, 780f * unit, unit, 55f * unit, settings, 24)!!
                val mirrored = side == "right"
                fun forward(x: Float) = if (mirrored) 780f * unit - x else x
                val expected = previewTraceGeometry(layout.deckViewportHeight * unit, 780f * unit,
                    forward(actual.deckEdgeX), layout.deckWidth * unit, 0f, forward(actual.center.x),
                    55f * unit, unit, settings, 24)!!
                assertEquals(expected.strokeWidth, actual.strokeWidth, 0f)
                assertEquals(expected.contactWidth, actual.contactWidth, 0f)
                assertEquals(expected.routes.size, actual.routes.size)
                for ((original, turned) in expected.routes.zip(actual.routes)) {
                    fun point(p: PreviewTracePoint) = PreviewTracePoint(forward(p.y), layout.deckY * unit + p.x)
                    assertEquals(original.points.map(::point), turned.points)
                    assertEquals(point(original.port), turned.port)
                    assertEquals(point(original.contactEnd), turned.contactEnd)
                    assertEquals(point(original.landing), turned.landing)
                    assertEquals(actual.deckEdgeX + (if (mirrored) -4f else 4f) * unit, turned.landing.x, .001f)
                }
            }
        }
    }

    @Test fun mirroredRoutesKeepHumanAboveAgentAndNeverWrapOutsideTheDeckHeight() {
        for (pattern in listOf("parallel", "splayed", "circuit")) for (radius in listOf(0f, 35f, 120f)) {
            val settings = PreviewTraces(pattern = pattern, stancePercent = 150, footSpacingPercent = 200)
            val left = previewLandscapeTraceGeometry(layout("left"), 780f, 1f, radius, settings)!!
            val right = previewLandscapeTraceGeometry(layout("right"), 780f, 1f, radius, settings)!!
            assertTrue(left.routes.isNotEmpty())
            for ((a, b) in left.routes.zip(right.routes)) {
                assertEquals(a.landing.y, b.landing.y, .001f)
                for ((p, q) in a.points.zip(b.points)) {
                    assertEquals(780f - p.x, q.x, .001f)
                    assertEquals(p.y, q.y, .001f)
                    assertTrue(p.y in 49f..311f)
                }
                for ((p, q) in a.points.zipWithNext()) assertTrue(q.x >= p.x)
                for ((p, q) in b.points.zipWithNext()) assertTrue(q.x <= p.x)
            }
            val split = left.routes.size / 2
            assertTrue(left.routes.take(split).all { it.landing.y < 180f - 5f })
            assertTrue(left.routes.drop(split).all { it.landing.y > 180f + 5f })
        }
    }

    @Test fun reachUsesTheActualApertureAndFadeNeverMovesItsFeet() {
        val layout = layout("left")
        val baseline = PreviewTraces()
        val feet = previewLandscapeTraceGeometry(layout, 780f, 1f, 80f, baseline)!!.routes.map { it.landing }
        for (reach in listOf(-40, 0, 30, 120)) for (fade in listOf(0, 80)) for (tip in listOf(0, 100)) {
            val settings = baseline.copy(reachDp = reach, fadeLengthDp = fade, tipOpacityPercent = tip)
            val join = previewTraceJoin(80f, 1f, settings)!!
            val traces = previewLandscapeTraceGeometry(layout, 780f, 1f, join.radiusPx, settings)!!
            assertEquals(feet, traces.routes.map { it.landing })
            for (route in traces.routes) {
                assertEquals(join.radiusPx, hypot(route.port.x - traces.center.x, route.port.y - traces.center.y), .001f)
            }
        }
    }

    @Test fun impossibleOrMisalignedAperturesNeverProduceReversedOrDetachedRoutes() {
        val layout = layout("left")
        assertTrue(previewLandscapeTraceGeometry(layout.copy(stageX = layout.stageX + 250f),
            780f, 1f, 80f)!!.routes.isEmpty())
        assertNull(previewLandscapeTraceGeometry(layout.copy(stageY = layout.stageY + 10f), 780f, 1f, 80f))
        assertNull(previewLandscapeTraceGeometry(layout, 780f, 0f, 80f))
        assertNull(previewLandscapeTraceGeometry(layout, Float.NaN, 1f, 80f))
        assertNull(previewLandscapeTraceGeometry(layout, 780f, 1f, -1f))
    }

    private fun layout(side: String) = previewOrientationGeometry(780f, 360f, 780f, false, 262f, 0f, side)
}
