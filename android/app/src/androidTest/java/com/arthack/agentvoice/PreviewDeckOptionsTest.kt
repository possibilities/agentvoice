package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

class PreviewDeckOptionsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun hidingPttReleasesItsFingerAndFillsTheDeckWithoutMovingPersona() {
        compose.mainClock.autoAdvance = false
        var state by mutableStateOf(PersonaPreviewState(design = PreviewDesign(controlsHeightDp = 300)))
        compose.setContent { VoiceTheme { Box(Modifier.requiredSize(320.dp, 720.dp)) { PersonaPreview(state) { state = it } } } }
        compose.mainClock.advanceTimeBy(1000)
        val stage = compose.onNodeWithTag("studio-persona-stage", true).getUnclippedBoundsInRoot()
        val deck = compose.onNodeWithTag("preview-controls").getUnclippedBoundsInRoot()
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertTrue(state.holding); state = state.copy(showPushToTalk = false) }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("hold-to-talk").assertDoesNotExist()
        compose.runOnIdle { assertFalse(state.holding); assertFalse(state.ui().canHold); assertEquals(state, state.beginHold()) }
        assertEquals(stage, compose.onNodeWithTag("studio-persona-stage", true).getUnclippedBoundsInRoot())
        assertEquals(deck, compose.onNodeWithTag("preview-controls").getUnclippedBoundsInRoot())
        for (tag in listOf("mic-mute", "speaker-mute")) {
            val bounds = compose.onNodeWithTag(tag).getUnclippedBoundsInRoot()
            assertEquals(deck.top, bounds.top); assertEquals(deck.bottom, bounds.bottom)
        }
        // Drain the old pointer at the root; it cannot turn a returning control into a hold.
        compose.onRoot().performTouchInput { up() }
        compose.runOnIdle { state = state.copy(showPushToTalk = true) }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("hold-to-talk").assertExists()
        compose.runOnIdle { assertFalse(state.holding); assertTrue(state.ui().canHold) }
    }

    @Test fun landscapeStacksMuteRowsWithFullHeightPttAndFitsWithoutScrolling() {
        var share by mutableStateOf(30.0)
        var shown by mutableStateOf(true)
        var mirrored by mutableStateOf(false)
        compose.setContent {
            VoiceTheme { PreviewControls(PersonaPreviewState().ui(), {}, {}, {}, Modifier.width(312.dp),
                controlsHeightDp = 480, holdSharePercent = share, availableHeightDp = 300f,
                spacing = PreviewSpacing(paddingDp = 16), showPushToTalk = shown, landscape = true, mirror = mirrored) }
        }
        for (side in listOf(false, true)) for (ratio in listOf(30.0, 60.0)) {
            compose.runOnIdle { mirrored = side; share = ratio }
            val deck = compose.onNodeWithTag("preview-controls").getUnclippedBoundsInRoot()
            val human = compose.onNodeWithTag("mic-mute").getUnclippedBoundsInRoot()
            val agent = compose.onNodeWithTag("speaker-mute").getUnclippedBoundsInRoot()
            val push = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
            assertEquals(300f, (deck.bottom - deck.top).value, .1f)
            assertEquals(human.left, agent.left); assertEquals(human.right, agent.right)
            assertEquals(16f, (agent.top - human.bottom).value, .1f)
            assertEquals(deck.top, push.top); assertEquals(deck.bottom, push.bottom)
            assertEquals((312 * ratio / 100).toFloat(), (push.right - push.left).value, .5f)
            assertTrue(if (side) push.right < human.left else push.left > human.right)
            for (bounds in listOf(human, agent, push)) {
                assertTrue(bounds.left >= deck.left && bounds.right <= deck.right)
                assertTrue(bounds.top >= deck.top && bounds.bottom <= deck.bottom)
            }
        }
        compose.runOnIdle { shown = false }
        compose.onNodeWithTag("hold-to-talk").assertDoesNotExist()
        compose.onNodeWithTag("mic-mute").assertWidthIsEqualTo(312.dp)
        compose.onNodeWithTag("speaker-mute").assertWidthIsEqualTo(312.dp)
    }

    @Test fun visibilityIsStrictSessionOnlyAndLegacyOffshootsAreDiscardedWithoutWriting() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "deck-options-${UUID.randomUUID()}.json")
        val base = PersonaPreviewState(sounds = PreviewSounds("rocker-29", 38))
        val session = PersonaPreviewSession(base.placement, file)
        fun request(state: PersonaPreviewState) = state.activeLayout().json()
            .put("id", 1).put("method", "preview").put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)
            .put("mode", state.mode).put("connection", state.connection).put("activity", state.activity)
            .put("theme", state.theme).put("mutedPresence", state.mutedPresence).put("mutedTuning", state.mutedTuning.json())
            .put("presenceScope", state.presenceScope).put("sounds", state.sounds.json()).put("showPushToTalk", state.showPushToTalk)
        try {
            for (bad in listOf(0, 1, "false", JSONObject.NULL)) {
                assertTrue(runCatching { session.command(request(session.state).put("showPushToTalk", bad)) }.isFailure)
                assertTrue(session.state.showPushToTalk); assertFalse(file.exists())
            }
            session.command(request(session.state).put("showPushToTalk", false))
            assertFalse(session.state.rotate("landscape").showPushToTalk)
            assertFalse(restorePersonaPreview(session.state.json(), session.state.saved).showPushToTalk)
            val state = session.state
            session.command(JSONObject().put("id", 2).put("method", "save").put("revision", state.revision)
                .put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch))
            val current = JSONObject(file.readText())
            assertEquals(17, current.getInt("version")); assertFalse(current.has("showPushToTalk"))
            assertFalse(current.toString().contains("offshootPercent"))
            val old = JSONObject(current.toString()).withLegacyOffshootFields().put("version", 16)
            old.getJSONObject("design").getJSONObject("traces").put("offshootPercent", 81)
            old.getJSONObject("sharedAppearance").getJSONObject("traces").put("offshootPercent", 81)
            old.getJSONObject("landscape").getJSONObject("design").getJSONObject("traces").put("offshootPercent", 81)
            old.getJSONObject("landscape").getJSONObject("design").getJSONObject("spacing").put("paddingDp", 7)
            val inconsistent = JSONObject(current.toString())
            inconsistent.getJSONObject("landscape").getJSONObject("design").getJSONObject("spacing").put("paddingDp", 7)
            assertTrue(runCatching { decodePreviewProfileLayouts(inconsistent.toString()) }.isFailure)
            val originalBytes = old.toString(2); file.writeText(originalBytes)
            assertEquals(decodePreviewProfileLayouts(current.toString()), decodePreviewProfileLayouts(file.readText()))
            assertEquals(originalBytes, file.readText())
            assertEquals(81, old.getJSONObject("design").getJSONObject("traces").getInt("offshootPercent"))
            for (bad in listOf(-1, 101, .5, "5", JSONObject.NULL)) {
                val broken = JSONObject(originalBytes)
                broken.getJSONObject("design").getJSONObject("traces").put("offshootPercent", bad)
                assertTrue(runCatching { decodePreviewProfileLayouts(broken.toString()) }.isFailure)
            }
            val legacyState = base.json().withLegacyOffshootFields().put("protocol", 18).apply { remove("showPushToTalk") }
            assertTrue(restorePersonaPreview(legacyState, base.saved).showPushToTalk)
            assertTrue(runCatching { decodePreviewTraces(old.getJSONObject("design").getJSONObject("traces")) }.isFailure)
        } finally { file.delete() }
    }
}
