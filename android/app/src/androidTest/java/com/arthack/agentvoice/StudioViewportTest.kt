package com.arthack.agentvoice

import android.graphics.Rect
import androidx.core.graphics.Insets
import androidx.core.view.WindowInsetsCompat
import org.junit.Assert.*
import org.junit.Test

class StudioViewportTest {
    @Test fun measuredViewportSerializesExactBarsAndAtMostSixteenCutouts() {
        val cutouts = (0..16).map { index -> Rect(index, index + 1, index + 20, index + 31) }
        val viewport = requireNotNull(studioViewport(1080, 2400, Insets.of(3, 101, 5, 123), cutouts))
        val json = viewport.json()
        assertEquals(setOf("width", "height", "systemBars", "cutouts"), json.fields())
        assertEquals(1080, json.getInt("width"))
        assertEquals(2400, json.getInt("height"))
        assertEquals("{\"left\":3,\"top\":101,\"right\":5,\"bottom\":123}",
            json.getJSONObject("systemBars").toString())
        assertEquals(16, json.getJSONArray("cutouts").length())
        assertEquals("{\"left\":15,\"top\":16,\"right\":35,\"bottom\":46}",
            json.getJSONArray("cutouts").getJSONObject(15).toString())
    }

    @Test fun unavailableInsetsOrUnlaidOutDimensionsProduceNoViewport() {
        assertNull(studioViewport(1080, 2400, null as WindowInsetsCompat?))
        assertNull(studioViewport(0, 2400, Insets.NONE, emptyList()))
        assertNull(studioViewport(1080, 0, Insets.NONE, emptyList()))
    }

    @Test fun visibleSystemBarsMayLegitimatelyMeasureZero() {
        val viewport = requireNotNull(studioViewport(1080, 2400, Insets.NONE, emptyList()))
        assertEquals(StudioViewportRect(0, 0, 0, 0), viewport.systemBars)
        assertTrue(viewport.cutouts.isEmpty())
    }
}
