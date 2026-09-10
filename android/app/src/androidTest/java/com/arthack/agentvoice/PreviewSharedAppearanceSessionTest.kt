package com.arthack.agentvoice

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class PreviewSharedAppearanceSessionTest {
    private fun request(state: PersonaPreviewState) = state.activeLayout().json()
        .put("method", "preview").put("id", 1).put("orientation", state.orientation)
        .put("orientationEpoch", state.orientationEpoch).put("mode", state.mode).put("connection", state.connection)
        .put("activity", state.activity).put("theme", state.theme).put("mutedPresence", state.mutedPresence)
        .put("mutedTuning", state.mutedTuning.json()).put("presenceScope", state.presenceScope).put("sounds", state.sounds.json()).put("showPushToTalk", state.showPushToTalk).put("icons", state.icons.json()).put("launcher", state.launcher)

    @Test fun sharedAppearanceEditsEitherOrientationWhileOverridesAndGeometryStayLocal() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "appearance-${UUID.randomUUID()}.json")
        val session = PersonaPreviewSession(defaultPortraitLayout().placement, file)
        suspend fun state() = withContext(Dispatchers.Main) { session.state }
        try {
            val original = state()
            withContext(Dispatchers.Main) { session.state = session.state.rotate("landscape") }
            val landscape = state()
            val edit = request(landscape).put("horizontalOffsetDp", 63)
            edit.getJSONObject("design").getJSONObject("traces").put("weightPercent", 222).put("glowPercent", 77)
            edit.getJSONObject("halo").put("containedSizePercent", 47).put("ringSpreadPercent", 80)
            session.command(edit)
            val shared = state()
            assertEquals(222, shared.design.traces.weightPercent)
            assertEquals(222, shared.otherLayout.design.traces.weightPercent)
            assertEquals(77, shared.otherLayout.design.traces.glowPercent)
            assertEquals(80, shared.otherLayout.halo.ringSpreadPercent)
            assertEquals(original.halo.containedSizePercent, shared.otherLayout.halo.containedSizePercent)
            assertEquals(47, shared.halo.containedSizePercent)
            assertEquals(63, shared.horizontalOffsetDp)
            assertEquals(0, shared.otherLayout.horizontalOffsetDp)
            assertEquals(original.placement, shared.otherLayout.placement)
            val local = request(shared).put("appearanceOverrides", JSONArray(listOf("glow", "traces")))
            local.getJSONObject("design").getJSONObject("traces").put("weightPercent", 123).put("glowPercent", 12)
            session.command(local)
            assertEquals(222, state().design.traces.weightPercent)
            val customized = request(state())
            customized.getJSONObject("design").getJSONObject("traces").put("weightPercent", 123).put("glowPercent", 12)
            session.command(customized)
            withContext(Dispatchers.Main) { session.state = session.state.rotate("portrait") }
            val portrait = state()
            val common = request(portrait)
            common.getJSONObject("design").getJSONObject("traces").put("weightPercent", 210).put("glowPercent", 91)
            session.command(common)
            assertEquals(123, state().otherLayout.design.traces.weightPercent)
            assertEquals(12, state().otherLayout.design.traces.glowPercent)
            withContext(Dispatchers.Main) { session.state = session.state.rotate("landscape") }
            // The request still contains local ink: unchecking must adopt shared, never promote the stale local copy.
            session.command(request(state()).put("appearanceOverrides", JSONArray()))
            val joined = state()
            assertEquals(210, joined.design.traces.weightPercent)
            assertEquals(91, joined.design.traces.glowPercent)
            assertEquals(63, joined.horizontalOffsetDp)
            assertEquals(47, joined.halo.containedSizePercent)
            assertFalse(file.exists())
            val reply = session.command(JSONObject().put("id", 2).put("method", "save").put("revision", joined.revision)
                .put("orientation", joined.orientation).put("orientationEpoch", joined.orientationEpoch))
            val profile = reply.getString("profile")
            val decoded = decodePreviewProfileLayouts(profile)
            assertEquals(20, JSONObject(profile).getInt("version"))
            assertEquals(joined.activeLayout(), decoded.landscape)
            assertEquals(joined.otherLayout, decoded.portrait)
            assertEquals(joined.sharedAppearance, decoded.shared)
            val saved = state()
            assertEquals(saved, restorePersonaPreview(saved.json(), decoded.portrait.placement, decoded.portrait.design,
                decoded.portrait.halo, decoded.portrait.spirit, decoded.landscape, decoded.portrait.personaSide,
                decoded.portrait.horizontalOffsetDp, decoded.portrait.appearanceOverrides, decoded.shared))
            assertTrue("Expanded profile receipt remains bounded", reply.toString().toByteArray().size < 16384)
            assertTrue(request(saved).toString().toByteArray().size < 8192)
        } finally { file.delete() }
    }

    @Test fun legacyDefaultsInheritButCustomLandscapeAppearanceAndGeometryArePreserved() {
        val portrait = defaultPortraitLayout().copy(design = defaultPortraitLayout().design.copy(
            traces = PreviewTraces("splayed", 101, 250, 50, 89, 200, -9, 80, 0)))
        fun legacy(landscape: PreviewLayout) = JSONObject(encodePersonaTuning(portrait.placement, portrait.design,
            portrait.halo, portrait.spirit, landscape)).withoutSharedAppearanceFields().put("version", 14).toString(2)
        val baseline = PreviewLayout()
        val text = legacy(baseline)
        val migrated = decodePreviewProfileLayouts(text)
        assertEquals(emptySet<String>(), migrated.landscape.appearanceOverrides)
        assertEquals(portrait.design.traces, migrated.landscape.design.traces)
        assertEquals(portrait.halo.variant, migrated.landscape.halo.variant)
        assertEquals(baseline.placement, migrated.landscape.placement)
        assertEquals(baseline.design.controlsHeightDp, migrated.landscape.design.controlsHeightDp)
        val custom = baseline.copy(design = baseline.design.copy(traces = baseline.design.traces.copy(weightPercent = 222, glowPercent = 17)),
            halo = baseline.halo.copy(containedSizePercent = 43, speakingMotionPercent = 80))
        val preserved = decodePreviewProfileLayouts(legacy(custom)).landscape
        assertEquals(setOf("glow", "halo", "traces"), preserved.appearanceOverrides)
        assertEquals(custom.design.traces, preserved.design.traces)
        assertEquals(custom.halo, preserved.halo)
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "appearance-legacy-${UUID.randomUUID()}.json")
        try { file.writeText(text); decodePreviewProfileLayouts(file.readText()); assertEquals(text, file.readText()) }
        finally { file.delete() }
    }

    @Test fun invalidScopeAndHorizontalRequestsAreRejectedAtomically() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "appearance-invalid-${UUID.randomUUID()}.json")
        val session = PersonaPreviewSession(defaultPortraitLayout().placement, file)
        val initial = withContext(Dispatchers.Main) { session.state }
        for (value in listOf(JSONArray(listOf("traces", "glow")), JSONArray(listOf("halo", "halo")), JSONArray(listOf("unknown")), JSONArray(listOf(1)), JSONObject.NULL)) {
            assertTrue(runCatching { session.command(request(initial).put("appearanceOverrides", value)) }.isFailure)
            assertEquals(initial, withContext(Dispatchers.Main) { session.state })
        }
        for (value in listOf(-201, 201, .5, "23", JSONObject.NULL)) {
            assertTrue(runCatching { session.command(request(initial).put("horizontalOffsetDp", value)) }.isFailure)
            assertEquals(initial, withContext(Dispatchers.Main) { session.state })
        }
        assertTrue(runCatching { session.command(request(initial).put("sharedAppearance", initial.sharedAppearance.json())) }.isFailure)
        assertFalse(file.exists())
    }
}
