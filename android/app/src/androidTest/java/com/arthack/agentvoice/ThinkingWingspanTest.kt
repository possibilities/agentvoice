package com.arthack.agentvoice

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ThinkingWingspanTest {
    @Test fun currentHaloRequiresAnIntegerWingspanWhileLegacyKeepsCompactReach() {
        for (value in 1..10) {
            val halo = PreviewHalo(thinkingWingspan = value)
            assertEquals(halo, decodePreviewHalo(halo.json()))
            assertEquals(value, halo.tuning().thinkingWingspan)
        }
        for (invalid in listOf(0, 11, 1.5, "2", true, JSONObject.NULL)) {
            assertTrue("Accepted invalid wingspan $invalid", runCatching {
                decodePreviewHalo(PreviewHalo().json().put("thinkingWingspan", invalid))
            }.isFailure)
        }
        val legacy = PreviewHalo().json().also { it.remove("thinkingWingspan") }
        assertTrue(runCatching { decodePreviewHalo(legacy) }.isFailure)
        assertEquals(2, decodePreviewHalo(legacy, legacyWingspan = true).thinkingWingspan)
        assertFalse(legacy.has("thinkingWingspan"))
        assertTrue(runCatching { decodePreviewHalo(PreviewHalo().json(), legacyWingspan = true) }.isFailure)
    }

    @Test fun currentAndLegacyCompleteProfilesPreserveEveryLayout() {
        val chosen = PreviewHalo(thinkingWingspan = 7)
        val profile = encodePersonaTuning(PersonaPlacement(), halo = chosen,
            landscape = PreviewLayout(halo = chosen.copy(thinkingWingspan = 10), appearanceOverrides = setOf("halo")))
        val decoded = decodePreviewProfileLayouts(profile)
        assertEquals(7, decoded.portrait.halo.thinkingWingspan)
        assertEquals(7, decoded.portraitReverse.halo.thinkingWingspan)
        assertEquals(10, decoded.landscape.halo.thinkingWingspan)
        assertEquals(10, decoded.landscapeReverse.halo.thinkingWingspan)
        assertEquals(7, decoded.shared.halo.thinkingWingspan)
        val legacy = JSONObject(profile).withoutThinkingWingspan().put("version", 22)
        val bytes = legacy.toString()
        val migrated = decodePreviewProfileLayouts(bytes)
        assertEquals(2, migrated.portrait.halo.thinkingWingspan)
        assertEquals(2, migrated.landscape.halo.thinkingWingspan)
        assertEquals(bytes, legacy.toString())
        assertTrue(runCatching { decodePreviewProfileLayouts(legacy.put("version", 23).toString()) }.isFailure)
    }
}
