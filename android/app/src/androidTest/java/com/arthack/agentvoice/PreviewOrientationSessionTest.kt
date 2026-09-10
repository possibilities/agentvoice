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

class PreviewOrientationSessionTest {
    private fun preview(state: PersonaPreviewState) = state.activeLayout().json()
        .put("id", 1).put("method", "preview").put("mode", state.mode).put("connection", state.connection)
        .put("activity", state.activity).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)
        .put("theme", state.theme).put("mutedPresence", state.mutedPresence).put("mutedTuning", state.mutedTuning.json()).put("presenceScope", state.presenceScope).put("sounds", state.sounds.json()).put("showPushToTalk", state.showPushToTalk).put("icons", state.icons.json()).put("launcher", state.launcher)

    @Test fun rotationFencesOldEditsEvenAfterRoundTripAndSavesBothLayouts() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "orientation-${UUID.randomUUID()}.json")
        val session = PersonaPreviewSession(PersonaPlacement(offsetY = (-22).dp), file,
            initialDesign = PreviewDesign(controlsHeightDp = 387), initialHalo = PreviewHalo(variant = "contained"))
        try {
            val portrait = withContext(Dispatchers.Main) { session.state }
            val oldEdit = preview(portrait).put("verticalOffsetDp", 101)
            val oldSave = JSONObject().put("id", 2).put("method", "save").put("revision", portrait.revision)
                .put("orientation", "portrait").put("orientationEpoch", 0)
            withContext(Dispatchers.Main) { session.state = session.state.beginHold().rotate("landscape") }
            val landscape = withContext(Dispatchers.Main) { session.state }
            assertFalse(landscape.holding)
            assertEquals(defaultLandscapeLayout().placement.offsetY, landscape.placement.offsetY)
            assertEquals(portrait.activeLayout(), landscape.otherLayout)
            for (request in listOf(oldEdit, oldSave, preview(landscape).apply { remove("orientationEpoch") })) {
                assertTrue(runCatching { session.command(request) }.isFailure)
                assertFalse(file.exists())
            }
            session.command(preview(landscape).put("verticalOffsetDp", 17).put("personaSide", "right"))
            withContext(Dispatchers.Main) { session.state = session.state.rotate("portrait") }
            val returned = withContext(Dispatchers.Main) { session.state }
            assertEquals(portrait.activeLayout(), returned.activeLayout())
            assertEquals(17.dp, returned.otherLayout.placement.offsetY)
            assertEquals("right", returned.otherLayout.personaSide)
            assertTrue(runCatching { session.command(oldEdit) }.isFailure)
            val reply = session.command(oldSave.put("revision", returned.revision).put("orientationEpoch", returned.orientationEpoch))
            val profile = reply.getString("profile")
            assertEquals((-22).dp, decodePersonaTuning(profile).offsetY)
            assertEquals(returned.otherLayout, decodeLandscapeLayout(profile))
            assertTrue("A maximal state + profile reply fits the bounded socket frame", reply.toString().toByteArray().size < 65536)
            assertTrue(profile.length <= 8192)
            val saved = withContext(Dispatchers.Main) { session.state }
            val restored = restorePersonaPreview(saved.rotate("landscape").json(), saved.saved, saved.savedDesign,
                saved.savedHalo, saved.savedSpirit, saved.savedOtherLayout, saved.savedPersonaSide)
            assertEquals(saved.rotate("landscape"), restored)
        } finally { file.delete() }
    }

    @Test fun oldProfilesSeedIndependentLandscapeWithoutChangingPortraitOrWriting() {
        val placement = PersonaPlacement(listeningScale = .41f, offsetY = (-83).dp)
        val v10 = JSONObject(encodePersonaTuning(placement)).apply {
            withoutTraceJoinFields(); put("version", 10); remove("landscape"); remove("personaSide")
            getJSONObject("design").remove("spacing")
        }.toString()
        assertEquals(placement, decodePersonaTuning(v10))
        assertEquals(PreviewLayout(), decodeLandscapeLayout(v10))
        assertEquals("left", decodePortraitSide(v10))
        val state = PersonaPreviewState(placement = placement).rotate("landscape")
            .copy(placement = PersonaPlacement(offsetY = 47.dp)).rotate("portrait")
        assertEquals(placement, state.placement)
        assertEquals(47.dp, state.otherLayout.placement.offsetY)
    }
}
