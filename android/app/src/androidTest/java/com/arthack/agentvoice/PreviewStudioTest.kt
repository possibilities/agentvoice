package com.arthack.agentvoice

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewStudioTest {
    @get:Rule val compose = createComposeRule()

    @Test fun tracePatternsKeepRockerTargetsFixedAndChannelsIndependent() {
        compose.mainClock.autoAdvance = false
        var state by mutableStateOf(PersonaPreviewState(mode = "idle", design = PreviewDesign()))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        compose.mainClock.advanceTimeBy(64)
        val targets = listOf("mic-mute", "speaker-mute", "hold-to-talk")
        val before = targets.map { compose.onNodeWithTag(it).getUnclippedBoundsInRoot() }
        for (pattern in listOf("parallel", "splayed", "circuit")) {
            compose.runOnIdle { state = state.select("idle").copy(design = state.design.copy(traces = PreviewTraces(pattern, 135, 190, 75, 60))) }
            compose.mainClock.advanceTimeBy(1200)
            assertEquals("$pattern moved a rocker target", before,
                targets.map { compose.onNodeWithTag(it).getUnclippedBoundsInRoot() })
            compose.onNodeWithTag("mic-mute").assertContentDescriptionEquals("HUMAN microphone").performClick()
            compose.mainClock.advanceTimeBy(64)
            compose.runOnIdle { assertFalse(state.micMuted); assertEquals("listening", state.mode) }
            compose.onNodeWithTag("speaker-mute").assertContentDescriptionEquals("AGENT speaker").performClick()
            compose.mainClock.advanceTimeBy(64)
            compose.runOnIdle { assertTrue(state.speakerMuted); assertFalse(state.micMuted) }
        }
        compose.onNodeWithTag("preview-header").assertDoesNotExist()
    }

    @Test fun connectionNoticesDoNotMoveTargetsAndCannotResumeAHeldMicrophone() {
        var state by mutableStateOf(PersonaPreviewState(mode = "idle"))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        val talk = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        val halo = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle {
            assertTrue(state.holding)
            state = state.endHold().copy(connection = "disconnected")
            assertFalse(state.ui().canHold)
            assertFalse(state.ui().micOpen)
            assertFalse(state.beginHold().holding)
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        for (connection in listOf("disconnected", "connecting", "connected")) {
            compose.runOnIdle { state = state.copy(connection = connection) }
            assertEquals(talk, compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot())
            assertEquals(halo, compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot())
            compose.runOnIdle { assertFalse(state.holding); assertFalse(state.ui().micOpen) }
            if (connection != "connected") {
                compose.onNodeWithTag("mic-mute").assertIsNotEnabled()
                compose.onNodeWithTag("hold-to-talk").assertIsNotEnabled()
            }
        }
    }

    @Test fun portraitKeepsSquareAndAllControlsInsideVisibleSpaceWithoutScrolling() {
        var state by mutableStateOf(PersonaPreviewState(mode = "idle"))
        compose.setContent {
            VoiceTheme {
                Box(Modifier.requiredSize(320.dp, 600.dp).testTag("portrait-viewport")) {
                    PersonaPreview(state) { state = it }
                }
            }
        }
        val stage = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true)
        val initial = stage.getUnclippedBoundsInRoot()
        stage.assertWidthIsEqualTo(320.dp).assertHeightIsEqualTo(320.dp)
        for (height in listOf(240, 380, 480)) for (padding in listOf(0, 16, 40)) {
            compose.runOnIdle { state = state.copy(design = state.design.copy(controlsHeightDp = height, spacing = PreviewSpacing(paddingDp = padding))) }
            assertEquals("Deck size cannot resize or move the square stage", initial, stage.getUnclippedBoundsInRoot())
            val mute = compose.onNodeWithTag("mic-mute").getUnclippedBoundsInRoot()
            val viewport = compose.onNodeWithTag("portrait-viewport").getUnclippedBoundsInRoot()
            val ptt = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
            assertTrue("Mute controls stay inside the visible viewport", mute.top >= viewport.top)
            assertTrue("PTT and bottom padding stay visible", ptt.bottom <= viewport.bottom - padding.dp)
            compose.onNodeWithTag("hold-to-talk").assertIsDisplayed()
        }
        val before = state.placement
        compose.onNodeWithTag("portrait-viewport").performTouchInput { swipeUp() }
        assertEquals("Portrait swipes cannot scroll Persona offscreen", initial, stage.getUnclippedBoundsInRoot())
        compose.onNodeWithTag("hold-to-talk").assertIsDisplayed()
        stage.assertWidthIsEqualTo(320.dp).assertHeightIsEqualTo(320.dp)
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { assertTrue(state.holding); assertEquals(before, state.placement) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        compose.runOnIdle { assertFalse(state.holding) }
    }
}
