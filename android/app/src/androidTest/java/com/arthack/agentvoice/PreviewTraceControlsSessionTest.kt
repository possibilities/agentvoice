package com.arthack.agentvoice

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class PreviewTraceControlsSessionTest {
    private fun preview(state: PersonaPreviewState) = state.activeLayout().json()
        .put("id", 1).put("method", "preview").put("mode", state.mode).put("connection", state.connection)
        .put("activity", state.activity).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)
        .put("theme", state.theme).put("mutedPresence", state.mutedPresence).put("mutedTuning", state.mutedTuning.json())
        .put("presenceScope", state.presenceScope).put("sounds", state.sounds.json()).put("showPushToTalk", state.showPushToTalk).put("icons", state.icons.json())

    @Test fun legacyProfilesAndSessionsGainJoinDefaultsAndSharedSpacingWithoutWriting() {
        val original = PersonaPreviewState(mutedPresence = "contacts", presenceScope = "always",
            placement = historicalPortraitLayout().placement, halo = historicalPortraitLayout().halo, spirit = historicalPortraitLayout().spirit,
            design = historicalPortraitLayout().design.copy(traces = PreviewTraces("splayed", 143, 230, 55, 72, 183)),
            otherLayout = historicalLandscapeLayout().copy(appearanceOverrides = setOf("glow", "traces"), design = PreviewDesign(traces = PreviewTraces("circuit", 85, 130, 60, 183, 61))))
        val migratedOther = original.otherLayout.copy(design = original.otherLayout.design.copy(spacing = original.design.spacing))
        val migrated = original.copy(otherLayout = migratedOther, savedOtherLayout = migratedOther)
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "trace-legacy-${UUID.randomUUID()}.json")
        try {
            val old = JSONObject(encodePersonaTuning(original.placement, original.design, original.halo, original.spirit,
                original.otherLayout, original.personaSide)).withoutTraceJoinFields().put("version", 13).toString(2)
            file.writeText(old)
            assertEquals(original.design, decodePersonaDesign(file.readText()))
            assertEquals(migratedOther, decodeLandscapeLayout(file.readText()))
            assertEquals(old, file.readText())
            val oldSession = original.json().withoutTraceJoinFields().put("protocol", 15)
            assertEquals(migrated, restorePersonaPreview(oldSession, original.saved, original.savedDesign,
                original.savedHalo, original.savedSpirit, original.savedOtherLayout, original.savedPersonaSide, original.savedHorizontalOffsetDp, original.savedAppearanceOverrides, original.savedSharedAppearance, savedAppearance = original.savedAppearance))
            assertTrue(runCatching { decodePersonaDesign(JSONObject(old).put("version", 14).toString()) }.isFailure)
        } finally { file.delete() }
    }

    @Test fun joinControlsAreAtomicOrientationScopedAndSavedOnlyExplicitly() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "trace-join-${UUID.randomUUID()}.json")
        val session = PersonaPreviewSession(defaultPortraitLayout().placement, file,
            initialOverrides = setOf("traces"), initialLandscape = defaultLandscapeLayout().copy(appearanceOverrides = setOf("traces")))
        try {
            val initial = withContext(Dispatchers.Main) { session.state }
            for ((field, bad) in listOf("reachDp" to -41, "reachDp" to 121, "fadeLengthDp" to -1,
                "fadeLengthDp" to 81, "tipOpacityPercent" to -1, "tipOpacityPercent" to 101,
                "reachDp" to .5, "fadeLengthDp" to "12", "tipOpacityPercent" to JSONObject.NULL)) {
                val request = preview(initial)
                request.getJSONObject("design").getJSONObject("traces").put(field, bad)
                assertTrue(runCatching { session.command(request) }.isFailure)
                assertEquals(initial, withContext(Dispatchers.Main) { session.state })
            }
            for (field in listOf("reachDp", "fadeLengthDp", "tipOpacityPercent")) {
                val request = preview(initial)
                request.getJSONObject("design").getJSONObject("traces").remove(field)
                assertTrue(runCatching { session.command(request) }.isFailure)
                assertEquals(initial, withContext(Dispatchers.Main) { session.state })
            }
            val portrait = initial.design.copy(traces = initial.design.traces.copy(reachDp = 67, fadeLengthDp = 43, tipOpacityPercent = 29))
            session.command(preview(initial).put("design", portrait.json()))
            withContext(Dispatchers.Main) { session.state = session.state.rotate("landscape") }
            val landscapeState = withContext(Dispatchers.Main) { session.state }
            assertEquals(portrait, landscapeState.otherLayout.design)
            val landscape = landscapeState.design.copy(traces = landscapeState.design.traces.copy(reachDp = -32, fadeLengthDp = 0, tipOpacityPercent = 100))
            session.command(preview(landscapeState).put("design", landscape.json()))
            withContext(Dispatchers.Main) { session.state = session.state.rotate("portrait") }
            val returned = withContext(Dispatchers.Main) { session.state }
            assertEquals(portrait, returned.design)
            assertEquals(landscape, returned.otherLayout.design)
            assertEquals(22, returned.json().getInt("protocol"))
            assertEquals(returned, restorePersonaPreview(returned.json(), returned.saved, returned.savedDesign,
                returned.savedHalo, returned.savedSpirit, returned.savedOtherLayout, returned.savedPersonaSide, returned.savedHorizontalOffsetDp, returned.savedAppearanceOverrides, returned.savedSharedAppearance))
            assertFalse(file.exists())
            val response = session.command(JSONObject().put("id", 2).put("method", "save").put("revision", returned.revision)
                .put("orientation", returned.orientation).put("orientationEpoch", returned.orientationEpoch))
            val saved = response.getString("profile")
            assertEquals(19, JSONObject(saved).getInt("version"))
            assertEquals(portrait, decodePersonaDesign(saved))
            assertEquals(landscape, decodeLandscapeLayout(saved).design)
            assertEquals(saved, file.readText())
            assertTrue(response.toString().toByteArray().size < 16384)
        } finally { file.delete() }
    }
}
