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
    private val cues = mutableListOf<PreviewSwitchCue>()
    private val output = object : PreviewSwitchOutput {
        override fun play(family: String, cue: PreviewSwitchCue, gain: Float): Boolean {
            assertEquals(ShippingDesign.sounds.family, family)
            assertEquals(ShippingDesign.sounds.volumePercent / 100f, gain)
            cues.add(cue)
            return true
        }
        override fun stop() { }
    }
    private val ready = CallUi(running = true, connected = true, phase = "Connected", micMuted = true,
        speakerMuted = false, speakerOpen = true, canHold = true)

    @Test fun holdReleaseAndCancellationFollowTheOwningPointer() {
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme { VoiceScreen(ready, soundOutput = output, stop = {}, mute = {},
                hold = { presses++ }, release = { releases++ }) }
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
            VoiceTheme { VoiceScreen(ui, soundOutput = output, stop = {}, mute = {},
                hold = { presses++ }, release = {}) }
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
            VoiceTheme { VoiceScreen(ready, soundOutput = output, stop = { ended = true },
                mute = { target = it }, hold = {}, release = {}) }
        }
        compose.onNodeWithTag("voice-screen")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Connected"))
        compose.onNodeWithTag("mic-mute").assertContentDescriptionEquals("HUMAN microphone").performTouchInput { click() }
        compose.runOnIdle { assertEquals("mic", target) }
        compose.onNodeWithTag("speaker-mute").assertContentDescriptionEquals("AGENT speaker").performTouchInput { click() }
        compose.runOnIdle { assertEquals("speaker", target) }
        val end = compose.onNodeWithTag("voice-screen").fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.CustomActions].single { it.label == "End call" }
        compose.runOnIdle { end.action() }
        compose.runOnIdle { assertTrue(ended) }
    }
    @Test fun shippingFeedbackWaitsForAcknowledgedMuteAndPairsRealHoldRelease() {
        var ui by mutableStateOf(ready)
        compose.setContent {
            VoiceTheme { VoiceScreen(ui, soundOutput = output, stop = {},
                mute = { ui = ui.copy(controlsPending = true) },
                hold = { ui = ui.copy(holding = true, micOpen = true) },
                release = { ui = ui.copy(holding = false, micOpen = false) }) }
        }
        compose.onNodeWithTag("mic-mute").performClick()
        compose.runOnIdle { assertTrue(cues.isEmpty()); ui = ui.copy(controlsPending = false, micMuted = false, micOpen = true, canHold = false) }
        compose.waitUntil { cues.size == 1 }
        compose.runOnIdle { assertEquals(listOf(PreviewSwitchCue.ToggleOn), cues); ui = ready }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(1, cues.size) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { assertEquals(PreviewSwitchCue.Down, cues.last()) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        compose.runOnIdle { assertEquals(PreviewSwitchCue.Up, cues.last()) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center); cancel() }
        compose.runOnIdle { assertEquals(PreviewSwitchCue.Down, cues.last()) }
    }

    @Test fun idleScreenHasNoEnrollmentActionsAndRespectsTheDistributorsIconLicense() {
        compose.setContent {
            VoiceTheme { VoiceScreen(CallUi(message = "Connection setup"), soundOutput = output,
                stop = {}, mute = {}, hold = {}, release = {}) }
        }
        compose.onNodeWithTag("start-voice").assertDoesNotExist()
        compose.onNodeWithText("Start voice").assertDoesNotExist()
        compose.onNodeWithText("Import device grant").assertDoesNotExist()
        compose.onNodeWithText("Replace device grant").assertDoesNotExist()
        compose.onNodeWithText("Connection setup").assertExists()
        compose.runOnIdle { assertTrue(cues.isEmpty()) }
        if (requiresShippingIconCredit(ShippingDesign.icons.channels, BuildConfig.PAID_NOUN_ICONS)) {
            compose.onNodeWithTag("shipping-credits").performClick()
            compose.onNodeWithText("Microphone and Volume by i cons", substring = true).assertExists()
            compose.onNodeWithText("Done").performClick()
        } else compose.onNodeWithTag("shipping-credits").assertDoesNotExist()
        assertTrue(requiresShippingIconCredit("noun-icons", false))
        assertFalse(requiresShippingIconCredit("noun-icons", true))
        assertTrue(requiresShippingIconCredit("noun-boatman", true))
    }
    @Test fun failedStartupDoesNotPretendToKeepConnectingAndOffersAnExit() {
        var stopped = false
        compose.setContent {
            VoiceTheme { VoiceScreen(CallUi(running = true, phase = "Voice unavailable"),
                soundOutput = output, stop = { stopped = true },
                mute = {}, hold = {}, release = {}) }
        }
        compose.onNodeWithTag("voice-failure").assertExists()
        compose.onNodeWithText("Connecting…").assertDoesNotExist()
        compose.onNodeWithTag("end-failed-call").performClick()
        compose.runOnIdle { assertTrue(stopped); assertTrue(cues.isEmpty()) }
    }

}
