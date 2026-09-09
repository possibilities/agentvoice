package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewStudioTest {
    @get:Rule val compose = createComposeRule()

    @Test fun bothMuteStylesKeepTargetsFixedAndToggleIndependently() {
        var state by mutableStateOf(PersonaPreviewState(mode = "idle"))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        val before = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        for (mute in listOf("rockers", "keycaps")) {
            compose.runOnIdle { state = state.select("idle").copy(design = PreviewDesign(mute = mute)) }
            assertEquals(before, compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot())
            compose.onNodeWithTag("mic-mute").assertContentDescriptionEquals("YOU microphone").performClick()
            compose.runOnIdle { assertFalse(state.micMuted); assertEquals("listening", state.mode) }
            compose.onNodeWithTag("speaker-mute").assertContentDescriptionEquals("AGENT speaker").performClick()
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

    @Test fun tallerControlsMoveThePersonaCenterWithoutChangingItsDiameter() {
        var state by mutableStateOf(PersonaPreviewState(mode = "idle"))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        val initial = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val button = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        compose.runOnIdle { state = state.copy(design = state.design.copy(controlsHeightDp = 380)) }
        val after = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals((initial.right - initial.left).value, (after.right - after.left).value, .5f)
        assertEquals((initial.bottom - initial.top).value, (after.bottom - after.top).value, .5f)
        assertTrue(after.top < initial.top)
        assertEquals(button.bottom, compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot().bottom)
    }
}
