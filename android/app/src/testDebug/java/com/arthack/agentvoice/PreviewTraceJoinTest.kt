package com.arthack.agentvoice

import kotlin.math.hypot
import org.junit.Assert.*
import org.junit.Test

class PreviewTraceJoinTest {
    @Test fun defaultsKeepTheExistingTwoDpShoulderAndTwelveDpFade() {
        val join = previewTraceJoin(100f, 2f, PreviewTraces())!!
        assertEquals(100f, join.radiusPx, 0f)
        assertEquals(24f, join.fadeLengthPx, 0f)
        assertEquals(0f, join.alphaAt(99f), 0f)
        assertEquals(0f, join.alphaAt(100f), 0f)
        assertEquals(.36f, join.alphaAt(102f), .00001f)
        assertEquals(.72f, join.alphaAt(104f), .00001f)
        assertEquals(1f, join.alphaAt(124f), 0f)
        assertEquals(listOf(0f to 0f, 100f / 124f to 0f, 104f / 124f to .72f, 1f to 1f), join.opacityStops())
    }

    @Test fun reachChangesOnlyTheJoiningRadiusAndCanExtendAllTheWayToCenter() {
        assertEquals(160f, previewTraceJoin(80f, 2f, PreviewTraces(reachDp = -40))!!.radiusPx, 0f)
        assertEquals(40f, previewTraceJoin(80f, 2f, PreviewTraces(reachDp = 20))!!.radiusPx, 0f)
        val centered = previewTraceJoin(80f, 2f, PreviewTraces(reachDp = 120, tipOpacityPercent = 60))!!
        assertEquals(0f, centered.radiusPx, 0f)
        assertEquals(.6f, centered.alphaAt(0f), .00001f)
        assertEquals(1f, centered.alphaAt(24f), .00001f)
    }

    @Test fun tipOpacityNeverLeaksIntoTheProtectedDisk() {
        for (tip in listOf(0, 40, 100)) {
            val join = previewTraceJoin(80f, 1f, PreviewTraces(reachDp = 20, fadeLengthDp = 60, tipOpacityPercent = tip))!!
            val tipAlpha = tip / 100f
            assertEquals(0f, join.alphaAt(0f), 0f)
            assertEquals(0f, join.alphaAt(59.999f), 0f)
            assertEquals(tipAlpha, join.alphaAt(60f), .00001f)
            assertEquals(tipAlpha + (1f - tipAlpha) * .72f, join.alphaAt(70f), .00001f)
            assertEquals(1f, join.alphaAt(120f), .00001f)
            assertEquals(1f, join.alphaAt(200f), .00001f)
            val samples = (0..240).map { join.alphaAt(it / 2f) }
            assertTrue(samples.zipWithNext().all { (a, b) -> a <= b + .000001f })
            assertTrue(join.opacityStops().zipWithNext().all { (a, b) -> a.first <= b.first })
        }
    }

    @Test fun zeroFadeIsAHardFullInkEdgeRegardlessOfTipOpacity() {
        for (tip in listOf(0, 50, 100)) {
            val hard = previewTraceJoin(60f, 1f, PreviewTraces(fadeLengthDp = 0, tipOpacityPercent = tip))!!
            assertEquals(0f, hard.alphaAt(59.99f), 0f)
            assertEquals(1f, hard.alphaAt(60f), 0f)
            assertEquals(1f, hard.alphaAt(61f), 0f)
            assertEquals(listOf(0f to 0f, 1f to 0f, 1f to 1f), hard.opacityStops())
            val center = previewTraceJoin(60f, 1f, PreviewTraces(reachDp = 120, fadeLengthDp = 0, tipOpacityPercent = tip))!!
            assertEquals(1f, center.alphaAt(0f), 0f)
            assertEquals(0f, center.outerRadiusPx, 0f)
        }
    }

    @Test fun routeStartsFollowTheJoinWithoutMovingButtonFeet() {
        val settings = PreviewTraces()
        fun geometry(join: PreviewTraceJoin) = previewTraceGeometry(400f, 800f, 500f, 262f, 24f,
            200f, join.radiusPx, 1f, settings)!!
        val baseline = geometry(previewTraceJoin(90f, 1f, settings)!!)
        val reached = geometry(previewTraceJoin(90f, 1f, settings.copy(reachDp = 30))!!)
        assertEquals(baseline.routes.map { it.landing }, reached.routes.map { it.landing })
        for (route in reached.routes) assertEquals(60f, hypot(route.port.x - 200f, route.port.y - 200f), .001f)
        val centered = geometry(previewTraceJoin(90f, 1f, settings.copy(reachDp = 120))!!)
        assertTrue(centered.routes.isNotEmpty())
        for (point in centered.routes.map { it.port }) {
            assertEquals(PreviewTracePoint(200f, 200f), point)
        }
        assertTrue(centered.routes.flatMap { it.points }.all { it.x.isFinite() && it.y.isFinite() })
    }

    @Test fun invalidPaintGeometryCannotCreateANonfiniteShader() {
        assertNull(previewTraceJoin(Float.NaN, 1f, PreviewTraces()))
        assertNull(previewTraceJoin(-1f, 1f, PreviewTraces()))
        assertNull(previewTraceJoin(10f, 0f, PreviewTraces()))
        assertNull(previewTraceJoin(10f, Float.POSITIVE_INFINITY, PreviewTraces()))
        assertNull(previewTraceJoin(Float.MAX_VALUE, Float.MAX_VALUE, PreviewTraces(reachDp = -40)))
    }
}
