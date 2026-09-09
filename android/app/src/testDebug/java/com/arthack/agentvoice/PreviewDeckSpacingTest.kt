package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewDeckSpacingTest {
    @Test fun joinsPreserveBothButtonFacesAndOnlyChangeDeckExtent() {
        for (height in listOf(240, 262, 387, 480)) for (share in listOf(30.0, 40.9, 60.0)) {
            val baseline = PreviewControlGeometry(height, share)
            for (join in listOf(0, 8, 16, 32, 48)) {
                val next = PreviewControlGeometry(height, share, join)
                assertEquals(baseline.muteHeightDp, next.muteHeightDp)
                assertEquals(baseline.holdHeightDp, next.holdHeightDp)
                assertEquals(height + join - 16f, next.extentHeightDp)
                assertEquals(next.extentHeightDp, next.muteHeightDp + next.holdHeightDp + join, .001f)
            }
        }
    }

    @Test fun traceFeetStayInsideActualChannelFacesAcrossGapAndStanceSettings() {
        for (gap in listOf(0, 10, 24, 40)) for (pattern in listOf("parallel", "splayed", "circuit")) {
            for (stance in listOf(75, 100, 150)) {
                val geometry = previewTraceGeometry(360f, 780f, 420f, 262f, 24f, 160f, 100f, 1f,
                    PreviewTraces(pattern = pattern, stancePercent = stance, footSpacingPercent = 200), gap)!!
                assertTrue(geometry.routes.isNotEmpty())
                for (route in geometry.routes) {
                    val x = route.landing.x
                    assertTrue("Foot entered the channel gap: x=$x gap=$gap", x < 180f - gap / 2f || x > 180f + gap / 2f)
                    assertTrue(x in 24f..336f)
                }
            }
        }
    }

    @Test fun landscapeBundlesIncludeTheFullStrokeInsideNarrowChannelEdges() {
        for (width in listOf(190.24f, 240f, 312f, 420f)) for (gap in listOf(0f, 10f, 40f)) {
            for (halfSpan in listOf(4f, 8f, 16f)) for (stance in listOf(75, 100, 150)) {
                val stroke = 3f
                val reach = previewLandscapeFootReach(width, gap, halfSpan, stroke, 1f, stance) ?: continue
                val nearestInk = reach - halfSpan - stroke / 2f
                val farthestInk = reach + halfSpan + stroke / 2f
                assertTrue(nearestInk >= gap / 2f)
                assertTrue(farthestInk <= width / 2f)
            }
        }
        assertNull(previewLandscapeFootReach(70f, 40f, 16f, 3f, 1f, 150))
    }

    @Test fun mutedEligibilityUsesEffectiveGatesAndForeground() {
        val muted = CallUi(connected = true, micMuted = true, speakerMuted = true)
        assertTrue(previewMutedEligible(muted, true))
        for (ui in listOf(muted.copy(micOpen = true, holding = true), muted.copy(speakerOpen = true),
            muted.copy(controlsPending = true), muted.copy(connected = false))) {
            assertFalse(previewMutedEligible(ui, true))
        }
        assertFalse(previewMutedEligible(muted, false))
        assertTrue(previewMutedEligible(muted.copy(micMuted = false, speakerMuted = false), true))
    }
}
