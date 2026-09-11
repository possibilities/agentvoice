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

class PreviewSoundsSessionTest {
    private fun preview(state: PersonaPreviewState) = state.activeLayout().json()
        .put("id", 1).put("method", "preview").put("mode", state.mode).put("connection", state.connection)
        .put("activity", state.activity).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)
        .put("theme", state.theme).put("mutedPresence", state.mutedPresence).put("mutedTuning", state.mutedTuning.json())
        .put("presenceScope", state.presenceScope).put("sounds", state.sounds.json()).put("showPushToTalk", state.showPushToTalk).put("icons", state.icons.json()).put("launcher", state.launcher)

    private fun save(state: PersonaPreviewState) = JSONObject().put("id", 2).put("method", "save")
        .put("revision", state.revision).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)

    private fun restore(data: JSONObject, saved: PersonaPreviewState): PersonaPreviewState =
        restorePersonaPreview(data, saved.saved, saved.savedDesign, saved.savedHalo, saved.savedSpirit,
            saved.savedOtherLayout, saved.savedPersonaSide, saved.savedHorizontalOffsetDp,
            saved.savedAppearanceOverrides, saved.savedSharedAppearance, saved.savedSounds)

    private fun file() = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
        "preview-sounds-${UUID.randomUUID()}.json")

    @Test fun soundObjectHasOnlyTheTwoBoundedFields() {
        for (family in listOf("off", "rocker-29", "rocker-13")) for (volume in listOf(0, 70, 100)) {
            val sounds = PreviewSounds(family, volume)
            assertEquals(sounds, decodePreviewSounds(sounds.json()))
        }
        for ((key, value) in listOf("family" to "other", "family" to 29, "family" to JSONObject.NULL,
            "volumePercent" to -1, "volumePercent" to 101, "volumePercent" to 70.5,
            "volumePercent" to "70", "volumePercent" to true, "volumePercent" to JSONObject.NULL,
            "extra" to 1)) {
            assertTrue("Reject $key=$value", runCatching {
                decodePreviewSounds(PreviewSounds().json().put(key, value))
            }.isFailure)
        }
        for (key in listOf("family", "volumePercent")) {
            assertTrue(runCatching { decodePreviewSounds(PreviewSounds().json().apply { remove(key) }) }.isFailure)
        }
    }

    @Test fun soundOnlyEditsAreAtomicAndNeverWriteBeforeSave() = runBlocking {
        val file = file()
        val previous = encodePersonaTuning(defaultPortraitLayout().placement)
        file.writeText(previous)
        try {
            val session = PersonaPreviewSession(defaultPortraitLayout().placement, file)
            val initial = withContext(Dispatchers.Main) { session.state }
            val invalid = listOf(
                preview(initial).apply { remove("sounds") },
                preview(initial).put("sounds", JSONObject.NULL),
                preview(initial).put("sounds", PreviewSounds().json().put("family", "unknown")),
                preview(initial).put("sounds", PreviewSounds().json().put("volumePercent", 101)),
                preview(initial).put("sounds", PreviewSounds().json().put("volumePercent", 1.5)),
                preview(initial).put("sounds", PreviewSounds().json().put("extra", true)),
            )
            for (request in invalid) {
                assertTrue(runCatching { session.command(request) }.isFailure)
                assertEquals(initial, withContext(Dispatchers.Main) { session.state })
                assertEquals(previous, file.readText())
            }
            val chosen = PreviewSounds("rocker-29", 83)
            session.command(preview(initial).put("sounds", chosen.json()))
            val edited = withContext(Dispatchers.Main) { session.state }
            assertEquals(initial.copy(sounds = chosen, revision = initial.revision + 1), edited)
            assertEquals(PreviewSounds(), edited.savedSounds)
            assertEquals(previous, file.readText())
            assertTrue(runCatching { session.command(save(initial)) }.isFailure)
            assertEquals(previous, file.readText())
        } finally { file.delete() }
    }

    @Test fun sharedSelectionSurvivesRotationAndSavesOnceAtTheProfileRoot() = runBlocking {
        val file = file()
        try {
            val session = PersonaPreviewSession(defaultPortraitLayout().placement, file)
            val initial = withContext(Dispatchers.Main) { session.state }
            val first = PreviewSounds("rocker-29", 0)
            session.command(preview(initial).put("sounds", first.json()))
            val stale = withContext(Dispatchers.Main) { preview(session.state) }
            withContext(Dispatchers.Main) { session.state = session.state.rotate("landscape") }
            val landscape = withContext(Dispatchers.Main) { session.state }
            assertEquals(first, landscape.sounds)
            assertEquals(initial.otherLayout, landscape.activeLayout())
            assertEquals(initial.activeLayout(), landscape.otherLayout)
            assertTrue(runCatching { session.command(stale) }.isFailure)
            val chosen = PreviewSounds("rocker-13", 100)
            session.command(preview(landscape).put("sounds", chosen.json()))
            val selected = withContext(Dispatchers.Main) { session.state }
            assertFalse(file.exists())
            val response = session.command(save(selected))
            val text = response.getString("profile")
            val profile = JSONObject(text)
            assertEquals(21, profile.getInt("version"))
            assertEquals(chosen, decodePersonaSounds(text))
            assertEquals(text, file.readText())
            assertFalse(profile.getJSONObject("landscape").has("sounds"))
            assertFalse(profile.getJSONObject("sharedAppearance").has("sounds"))
            val saved = withContext(Dispatchers.Main) { session.state.rotate("portrait") }
            assertEquals(chosen, saved.sounds)
            assertEquals(chosen, saved.savedSounds)
            assertEquals(saved, restore(saved.json(), saved))
            val stateJson = saved.json()
            assertEquals(28, stateJson.getInt("protocol"))
            assertEquals(ShippingDesign.sounds, decodePreviewSounds(stateJson.getJSONObject("defaultSounds")))
            assertFalse(stateJson.getJSONObject("otherLayout").has("sounds"))
            assertTrue(response.toString().toByteArray().size < 65536)
        } finally { file.delete() }
    }

    @Test fun oldProfilesAndSessionsDefaultOffWithoutRewritingTheirBytes() {
        val file = file()
        try {
            for (version in 1..15) {
                val old = JSONObject(encodePersonaTuning(defaultPortraitLayout().placement))
                    .withLegacyOffshootFields().put("version", version).apply { remove("sounds") }.toString(2)
                file.writeText(old)
                assertEquals(PreviewSounds(), decodePersonaSounds(file.readText()))
                assertEquals(old, file.readText())
            }
            val previous = PersonaPreviewState()
            val oldSession = previous.json().withLegacyOffshootFields().put("protocol", 17).apply {
                remove("sounds"); remove("savedSounds"); remove("defaultSounds")
            }
            assertEquals(previous, restore(oldSession, previous))
            val olderSession = JSONObject(oldSession.toString()).put("protocol", 16).apply {
                getJSONObject("otherLayout").apply { remove("horizontalOffsetDp"); remove("appearanceOverrides") }
            }
            val restored = restore(olderSession, previous)
            assertEquals(PreviewSounds(), restored.sounds)
            assertEquals(PreviewSounds(), restored.savedSounds)
        } finally { file.delete() }
    }

    @Test fun currentProfileAndRestoreRequireCompleteSoundContracts() {
        val state = PersonaPreviewState(sounds = PreviewSounds("rocker-13", 39), savedSounds = PreviewSounds("rocker-29", 84))
        val profile = JSONObject(encodePersonaTuning(state.placement, sounds = state.sounds))
        assertEquals(state.sounds, decodePersonaSounds(profile.toString()))
        assertTrue(runCatching { decodePersonaSounds(JSONObject(profile.toString()).apply { remove("sounds") }.toString()) }.isFailure)
        assertTrue(runCatching { decodePersonaSounds(JSONObject(profile.toString()).put("sounds", PreviewSounds().json().put("extra", 1)).toString()) }.isFailure)
        for (field in listOf("sounds", "savedSounds", "defaultSounds")) {
            assertTrue(runCatching { restore(state.json().apply { remove(field) }, state) }.isFailure)
            assertTrue(runCatching { restore(state.json().put(field, PreviewSounds().json().put("volumePercent", "70")), state) }.isFailure)
        }
        // Old advertised defaults can differ after promotion; they never override current or saved sound choices.
        assertEquals(state, restore(state.json().put("defaultSounds", state.sounds.json()), state))
        assertEquals(state, restore(state.json(), state))
        val savedProfileBaseline = PreviewSounds("rocker-29", 10)
        val restored = restore(state.json(), state.copy(savedSounds = savedProfileBaseline))
        assertEquals(state.sounds, restored.sounds)
        assertEquals(savedProfileBaseline, restored.savedSounds)
    }

    @Test fun selectedProfileSoundsInitializeBothLiveAndSavedValues() {
        val chosen = PreviewSounds("rocker-29", 61)
        val file = file()
        val session = PersonaPreviewSession(defaultPortraitLayout().placement, file, initialSounds = chosen)
        assertEquals(chosen, session.state.sounds)
        assertEquals(chosen, session.state.savedSounds)
        assertFalse(file.exists())
    }
}
