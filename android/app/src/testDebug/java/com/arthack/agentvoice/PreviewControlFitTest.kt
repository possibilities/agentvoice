package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewControlFitTest {
    @Test fun requestedGeometryIsPreservedUntilTheVisibleBudgetRequiresFitting() {
        for (height in listOf(240, 387, 480)) for (gap in listOf(0, 16, 40, 48)) {
            val requested = PreviewControlGeometry(height, 39.3, gap)
            val normal = requested.fitWithin(null)
            assertEquals(normal, requested.fitWithin(requested.extentHeightDp + 100f))
            for (budget in listOf(80f, 200f, 400f)) {
                val fit = requested.fitWithin(budget)
                assertTrue(fit.extent <= budget)
                assertEquals(fit.extent, fit.mute + fit.gap + fit.hold, .001f)
                assertEquals(requested.muteHeightDp / requested.holdHeightDp, fit.mute / fit.hold, .001f)
                assertTrue(fit.mute > 0 && fit.hold > 0 && fit.gap >= 0)
            }
        }
    }
}
