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

    @Test fun landscapeBundlesStayInsideTheStackedChannelEdges() {
        for (height in listOf(190.24f, 240f, 312f)) for (gap in listOf(0, 10, 40)) {
            for (pattern in listOf("parallel", "splayed", "circuit")) for (stance in listOf(75, 100, 150)) {
                val layout = previewOrientationGeometry(780f, 360f, 780f, false, height, 0f)
                val traces = previewLandscapeTraceGeometry(layout, 780f, 1f, 35f,
                    PreviewTraces(pattern = pattern, stancePercent = stance, weightPercent = 250,
                        footSpacingPercent = 200), gap)!!
                assertTrue(traces.routes.isNotEmpty())
                val centerY = layout.deckY + layout.deckViewportHeight / 2f
                for (route in traces.routes) {
                    val distance = kotlin.math.abs(route.landing.y - centerY)
                    assertTrue(distance - traces.strokeWidth / 2f >= gap / 2f)
                    assertTrue(distance + traces.strokeWidth / 2f <= layout.deckViewportHeight / 2f)
                }
            }
        }
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
