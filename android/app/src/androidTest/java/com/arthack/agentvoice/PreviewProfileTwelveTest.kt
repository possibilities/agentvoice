package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class PreviewProfileTwelveTest {
    private fun fixture() = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
        "profile-twelve-${UUID.randomUUID()}.json")

    private fun preview(state: PersonaPreviewState) = state.activeLayout().json()
        .put("id", 1).put("method", "preview").put("mode", state.mode).put("connection", state.connection)
        .put("activity", state.activity).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)
        .put("theme", state.theme).put("mutedPresence", state.mutedPresence).put("mutedTuning", state.mutedTuning.json())

    private fun save(state: PersonaPreviewState) = JSONObject().put("id", 2).put("method", "save")
        .put("revision", state.revision).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)

    @Test fun versionElevenPreservesUnequalLayoutsAndSavedBytesWithBaselineSpacing() {
        val portrait = PreviewLayout(PersonaPlacement(.91f, .43f, .67f, (-83).dp),
            PreviewDesign(controlsHeightDp = 411, holdSharePercent = 57.2, traces = PreviewTraces("circuit", 143, 210, 57, 61, 75, 175)),
            PreviewHalo(variant = "original", containedSizePercent = 102), PreviewSpirit("soft", 81, "fixed"), "right")
        val landscape = PreviewLayout(PersonaPlacement(.52f, .49f, .61f, 47.dp),
            PreviewDesign(controlsHeightDp = 279, holdSharePercent = 31.4, traces = PreviewTraces("splayed", 87, 73, 12, 19, 180, 60)),
            PreviewHalo(variant = "contained", containedSizePercent = 69), PreviewSpirit("still", 26, "follow"), "left")
        val old = JSONObject(encodePersonaTuning(portrait.placement, portrait.design, portrait.halo, portrait.spirit,
            landscape, portrait.personaSide)).apply {
            put("version", 11)
            getJSONObject("design").remove("spacing")
            getJSONObject("landscape").getJSONObject("design").remove("spacing")
        }.toString(2)
        val file = fixture()
        try {
            file.writeText(old)
            val bytes = file.readBytes()
            val read = file.readText()
            assertEquals(portrait.placement, decodePersonaTuning(read))
            assertEquals(portrait.design, decodePersonaDesign(read))
            assertEquals(portrait.halo, decodePersonaHalo(read))
            assertEquals(portrait.spirit, decodePersonaSpirit(read))
            assertEquals(portrait.personaSide, decodePortraitSide(read))
            assertEquals(landscape, decodeLandscapeLayout(read))
            assertArrayEquals(bytes, file.readBytes())
            assertEquals(11, JSONObject(file.readText()).getInt("version"))
            val v10 = JSONObject(old).apply { put("version", 10); remove("landscape"); remove("personaSide") }.toString()
            assertEquals(portrait.design, decodePersonaDesign(v10))
            assertEquals(PreviewLayout(), decodeLandscapeLayout(v10))
        } finally { file.delete() }
    }

    @Test fun historicalOmissionsKeepLegacyDefaultsAndResetSnapshotsUseActiveOrientation() {
        val v1 = "{\"version\":1,\"scaleMultiplier\":0.64}"
        assertEquals(PersonaPlacement(.64f, .64f, .64f, 35.dp), decodePersonaTuning(v1))
        assertEquals(PreviewDesign(), decodePersonaDesign(v1))
        assertEquals(PreviewHalo(), decodePersonaHalo(v1))
        assertEquals(PreviewSpirit(), decodePersonaSpirit(v1))
        assertEquals(PreviewLayout(), decodeLandscapeLayout(v1))
        for (orientation in previewOrientations) {
            val state = if (orientation == "portrait") PersonaPreviewState() else PersonaPreviewState().rotate(orientation)
            val json = state.json()
            val defaults = defaultPreviewLayout(orientation)
            assertEquals(defaults.design, decodePreviewDesign(json.getJSONObject("defaultDesign")))
            assertEquals(defaults.halo, decodePreviewHalo(json.getJSONObject("defaultHalo")))
            assertEquals(defaults.spirit, decodePreviewSpirit(json.getJSONObject("defaultSpirit")))
            assertEquals(defaults.placement.offsetY.value.toInt(), json.getInt("defaultVerticalOffsetDp"))
            assertEquals(defaults.placement.scalesJson().toString(), json.getJSONObject("defaults").toString())
        }
    }

    @Test fun presentationIsRestoredAcrossRotationButNeverSavedAndOldRequestsRemainFenced() = runBlocking {
        val file = fixture()
        val session = PersonaPreviewSession(defaultPortraitLayout().placement, file)
        try {
            val initial = withContext(Dispatchers.Main) { session.state }
            val tuning = PreviewMutedTuning(28, 75, 230, 80, 8, "ripple")
            val staleEdit = preview(initial)
            val staleSave = save(initial)
            session.command(preview(initial).put("theme", "quiet").put("mutedPresence", "off")
                .put("mutedTuning", tuning.json())
                .put("design", initial.design.copy(spacing = PreviewSpacing(200, 0, 80, 40, 48)).json()))
            withContext(Dispatchers.Main) { session.state = session.state.beginHold().rotate("landscape") }
            val landscape = withContext(Dispatchers.Main) { session.state }
            assertFalse(landscape.holding)
            assertEquals("quiet", landscape.theme)
            assertEquals("off", landscape.mutedPresence)
            assertEquals(tuning, landscape.mutedTuning)
            assertEquals(PreviewSpacing(paddingDp = 16), landscape.design.spacing)
            session.command(preview(landscape).put("theme", "grayscale")
                .put("design", landscape.design.copy(spacing = PreviewSpacing(0, 200, 17, 0, 0)).json()))
            withContext(Dispatchers.Main) { session.state = session.state.rotate("portrait") }
            val returned = withContext(Dispatchers.Main) { session.state }
            assertEquals(PreviewSpacing(200, 0, 80, 40, 48), returned.design.spacing)
            assertEquals("grayscale", returned.theme)
            assertTrue(runCatching { session.command(staleEdit) }.isFailure)
            assertTrue(runCatching { session.command(staleSave) }.isFailure)
            assertFalse(file.exists())
            val reply = session.command(save(returned))
            val profile = reply.getString("profile")
            val encoded = JSONObject(profile)
            assertEquals(13, encoded.getInt("version"))
            assertFalse(encoded.has("theme"))
            assertFalse(encoded.has("mutedPresence"))
            assertFalse(encoded.has("mutedTuning"))
            assertFalse(encoded.getJSONObject("landscape").has("mutedTuning"))
            assertFalse(encoded.getJSONObject("landscape").has("theme"))
            assertFalse(encoded.getJSONObject("landscape").has("mutedPresence"))
            assertEquals(returned.design, decodePersonaDesign(profile))
            assertEquals(returned.otherLayout, decodeLandscapeLayout(profile))
            assertEquals(profile, file.readText())
            assertTrue(reply.toString().toByteArray().size < 8192)
            val saved = withContext(Dispatchers.Main) { session.state }
            val restored = restorePersonaPreview(saved.rotate("landscape").json(), saved.saved, saved.savedDesign,
                saved.savedHalo, saved.savedSpirit, saved.savedOtherLayout, saved.savedPersonaSide)
            assertEquals(saved.rotate("landscape"), restored)
            val oldState = saved.json().apply {
                put("protocol", 11); remove("theme"); remove("mutedPresence")
                getJSONObject("design").remove("spacing")
                getJSONObject("otherLayout").getJSONObject("design").remove("spacing")
            }
            val oldRestored = restorePersonaPreview(oldState, saved.saved, saved.savedDesign,
                saved.savedHalo, saved.savedSpirit, saved.savedOtherLayout, saved.savedPersonaSide)
            assertEquals("bright", oldRestored.theme)
            assertEquals("tide", oldRestored.mutedPresence)
            assertEquals(PreviewMutedTuning(), oldRestored.mutedTuning)
            assertEquals(PreviewSpacing(), oldRestored.design.spacing)
        } finally { file.delete() }
    }

    @Test fun currentSpacingAndSessionPresentationAreStrictlyValidated() = runBlocking {
        val design = PreviewDesign().json()
        assertThrows(IllegalArgumentException::class.java) {
            decodePreviewDesign(JSONObject(design.toString()).apply { remove("spacing") })
        }
        for (bad in listOf(-1, 201, 1.5, "100", JSONObject.NULL)) {
            assertTrue(runCatching { decodePreviewSpacing(PreviewSpacing().json().put("sideMarginPercent", bad)) }.isFailure)
        }
        assertTrue(runCatching { decodePreviewSpacing(PreviewSpacing().json().put("extra", 1)) }.isFailure)
        val file = fixture()
        val session = PersonaPreviewSession(defaultPortraitLayout().placement, file)
        try {
            val before = withContext(Dispatchers.Main) { session.state }
            for (request in listOf(preview(before).put("theme", "neon"), preview(before).put("mutedPresence", "always"),
                preview(before).apply { remove("theme") }, preview(before).apply { remove("mutedTuning") },
                preview(before).put("mutedTuning", PreviewMutedTuning().json().put("cycleSeconds", 0)))) {
                assertTrue(runCatching { session.command(request) }.isFailure)
                assertEquals(before, withContext(Dispatchers.Main) { session.state })
                assertFalse(file.exists())
            }
        } finally { file.delete() }
    }
    @Test fun versionTwelveAddsCustomPaddingWithoutChangingEitherLayoutOrSavedBytes() {
        val portrait = defaultPortraitLayout().copy(design = defaultPortraitLayout().design.copy(
            spacing = PreviewSpacing(137, 63, 19, 7, 31)))
        val landscape = defaultLandscapeLayout().copy(design = defaultLandscapeLayout().design.copy(
            spacing = PreviewSpacing(42, 178, 23, 29, 9)))
        val old = JSONObject(encodePersonaTuning(portrait.placement, portrait.design, portrait.halo,
            portrait.spirit, landscape, portrait.personaSide)).apply {
            put("version", 12)
            getJSONObject("design").getJSONObject("spacing").remove("paddingDp")
            getJSONObject("landscape").getJSONObject("design").getJSONObject("spacing").remove("paddingDp")
        }
        val file = fixture()
        try {
            file.writeText(old.toString(2))
            val bytes = file.readBytes()
            assertEquals(portrait.design, decodePersonaDesign(file.readText()))
            assertEquals(landscape, decodeLandscapeLayout(file.readText()))
            assertArrayEquals(bytes, file.readBytes())
            val oldSession = PersonaPreviewState(design = portrait.design, otherLayout = landscape,
                mutedTuning = PreviewMutedTuning(24, 65, 200, 70, 10, "ripple")).json().apply {
                put("protocol", 13)
                getJSONObject("design").getJSONObject("spacing").remove("paddingDp")
                getJSONObject("otherLayout").getJSONObject("design").getJSONObject("spacing").remove("paddingDp")
            }
            val restored = restorePersonaPreview(oldSession, portrait.placement, portrait.design,
                portrait.halo, portrait.spirit, landscape, portrait.personaSide)
            assertEquals(portrait.design, restored.design)
            assertEquals(landscape, restored.otherLayout)
            assertEquals("ripple", restored.mutedTuning.motion)
            assertThrows(IllegalArgumentException::class.java) {
                decodePreviewDesign(old.getJSONObject("design"))
            }
            assertThrows(IllegalArgumentException::class.java) {
                decodePersonaDesign(JSONObject(old.toString()).apply {
                    getJSONObject("design").getJSONObject("spacing").put("paddingDp", 16)
                }.toString())
            }
        } finally { file.delete() }
    }

}
