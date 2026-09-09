package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class VoiceScreenTest {
    @get:Rule val compose = createComposeRule()
    private val ready = CallUi(running = true, connected = true, phase = "Connected", micMuted = true,
        speakerMuted = false, speakerOpen = true, canHold = true)

    @Test fun holdReleaseAndCancellationFollowTheOwningPointer() {
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme { VoiceScreen(ready, true, start = {}, stop = {}, importGrant = {}, mute = {},
                hold = { presses++ }, release = { releases++ }, preview = true) }
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { assertEquals(1, presses); assertEquals(0, releases) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        compose.runOnIdle { assertEquals(1, releases) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center); cancel() }
        compose.runOnIdle { assertEquals(2, presses); assertEquals(2, releases) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput {
            down(0, center); down(1, center + Offset(10f, 0f)); up(0); up(1)
        }
        compose.runOnIdle { assertEquals(3, presses); assertEquals(3, releases) }
    }
    @Test fun disabledHoldStaysInPlaceAndDoesNotTransmit() {
        var ui by mutableStateOf(ready)
        var presses = 0
        compose.setContent {
            VoiceTheme { VoiceScreen(ui, true, start = {}, stop = {}, importGrant = {}, mute = {},
                hold = { presses++ }, release = {}, preview = true) }
        }
        val before = compose.onNodeWithTag("hold-to-talk").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { ui = ready.copy(canHold = false, micMuted = false, micOpen = true) }
        compose.onNodeWithTag("hold-to-talk").assertIsNotEnabled().performTouchInput { click() }
        val after = compose.onNodeWithTag("hold-to-talk").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { assertEquals(before, after); assertEquals(0, presses) }
    }
    @Test fun channelNamesAndEndCallAreAccessible() {
        var target: String? = null
        var ended = false
        compose.setContent {
            VoiceTheme { VoiceScreen(ready, true, start = {}, stop = { ended = true }, importGrant = {},
                mute = { target = it }, hold = {}, release = {}, preview = true) }
        }
        compose.onNodeWithTag("connection-status").assertContentDescriptionEquals("Connection")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Connected"))
        compose.onNodeWithTag("mic-mute").assertContentDescriptionEquals("YOU microphone").performTouchInput { click() }
        compose.runOnIdle { assertEquals("mic", target) }
        compose.onNodeWithTag("speaker-mute").assertContentDescriptionEquals("AGENT speaker").performTouchInput { click() }
        compose.runOnIdle { assertEquals("speaker", target) }
        compose.onNodeWithTag("end-call").assertContentDescriptionEquals("End call").performTouchInput { click() }
        compose.runOnIdle { assertTrue(ended) }
    }
}
