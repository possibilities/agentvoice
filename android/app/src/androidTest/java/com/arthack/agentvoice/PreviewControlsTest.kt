package com.arthack.agentvoice

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewControlsTest {
    @get:Rule val compose = createComposeRule()
    private val ready = CallUi(running = true, connected = true, phase = "Connected", micMuted = true,
        speakerMuted = false, speakerOpen = true, canHold = true)

    @Test fun pendingMuteAcknowledgementsKeepThePushLabelStable() {
        var ui by mutableStateOf(ready)
        var vertical by mutableStateOf(false)
        compose.setContent {
            VoiceTheme { RockerHoldFace(ui, VoiceInk.you, VoiceInk.surface,
                if (vertical) Modifier.requiredSize(180.dp, 340.dp) else Modifier.requiredSize(320.dp, 130.dp),
                light = null, acknowledgedTouch = false) }
        }
        for (landscape in listOf(false, true)) {
            compose.runOnIdle { vertical = landscape }
            for (pending in listOf(false, true)) {
                compose.runOnIdle { ui = ready.copy(controlsPending = pending, canHold = !pending) }
                compose.onNodeWithText("Push").assertExists()
                compose.onNodeWithText("to talk").assertExists()
                compose.onNodeWithText("Updating controls").assertDoesNotExist()
                compose.onNodeWithText("Updating").assertDoesNotExist()
                compose.runOnIdle { ui = ready.copy(micMuted = false, micOpen = true, canHold = false, controlsPending = pending) }
                compose.onNodeWithText(if (landscape) "Live\nnow" else "Live now").assertExists()
            }
            for (pending in listOf(
                ready.copy(holding = true, micOpen = false),
                ready.copy(holding = true, micOpen = false, controlsPending = true),
                ready.copy(micMuted = false, micOpen = false, canHold = false, controlsPending = true),
            )) {
                compose.runOnIdle { ui = pending }
                compose.onNodeWithText("Push").assertExists()
                compose.onNodeWithText("to talk").assertExists()
                for (transient in listOf("Opening", "Wait", "for mic", "for microphone"))
                    compose.onNodeWithText(transient).assertDoesNotExist()
                compose.onNodeWithText(if (landscape) "Live\nnow" else "Live now").assertDoesNotExist()
            }
        }
    }

    @Test fun touchingAnOpenMicGivesQuietFeedbackWithoutAcquiringOrChangingAHold() {
        val open = ready.copy(micMuted = false, micOpen = true, canHold = false)
        var ui by mutableStateOf(open)
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme { PreviewControls(ui, {}, { presses++ }, { releases++ }, Modifier.width(312.dp)) }
        }
        val push = compose.onNodeWithTag("hold-to-talk")
        val bounds = push.getUnclippedBoundsInRoot()
        fun faceGreen(): Float {
            val pixels = push.captureToImage().toPixelMap()
            // Empty face area, away from glyph, text, lip and bevel.
            return pixels[(pixels.width * .85f).toInt(), (pixels.height * .35f).toInt()].green
        }
        val resting = faceGreen()
        push.performTouchInput { down(center) }
        val touched = faceGreen()
        assertTrue("Touch must be visible", touched > resting + .01f)
        assertTrue("Touch stays a quiet acknowledgement", touched < resting + .05f)
        push.assertIsNotEnabled().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Live now. Microphone open"))
        assertEquals(bounds, push.getUnclippedBoundsInRoot())
        compose.runOnIdle { assertEquals(open, ui); assertEquals(0, presses); assertEquals(0, releases) }
        push.performTouchInput { up() }
        assertEquals(resting, faceGreen(), .001f)
        for (ending in listOf("cancel", "exit", "second")) {
            push.performTouchInput { down(center) }
            assertTrue(faceGreen() > resting)
            push.performTouchInput {
                when (ending) {
                    "cancel" -> cancel()
                    "exit" -> { moveTo(Offset(-50f, -50f)); moveTo(center); up() }
                    else -> { down(1, center + Offset(10f, 0f)); up(0); up(1) }
                }
            }
            assertEquals(resting, faceGreen(), .001f)
        }
        push.performTouchInput { down(center) }
        compose.runOnIdle { ui = open.copy(controlsPending = true) }
        assertEquals(resting, faceGreen(), .001f)
        compose.runOnIdle { ui = open }
        assertEquals("Returning gates cannot revive the old touch", resting, faceGreen(), .001f)
        compose.runOnIdle { ui = ready }
        push.performTouchInput { moveTo(center); up() }
        compose.runOnIdle { assertEquals(0, presses); assertEquals(0, releases); assertFalse(ui.holding) }
        // The same surface still owns a genuine PTT press after the old finger is lifted.
        push.performTouchInput { down(center) }
        compose.runOnIdle { assertEquals(1, presses); ui = ready.copy(holding = true, micOpen = true) }
        assertTrue("Confirmed PTT is stronger than touch feedback", faceGreen() > touched + .025f)
        push.performTouchInput { up() }
        compose.runOnIdle { assertEquals(1, releases) }
    }

    @Test fun rockerWaitsForConfirmationAndReleasesOnUpCancelExitAndSecondPointer() {
        var ui by mutableStateOf(ready)
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme {
                PreviewControls(ui, {}, {
                    presses++
                    ui = ui.copy(holding = true, micOpen = false)
                }, {
                    releases++
                    ui = ui.copy(holding = false, micOpen = false)
                }, Modifier.width(312.dp))
            }
        }
        val push = compose.onNodeWithTag("hold-to-talk")
        push.assertContentDescriptionEquals("Push to talk")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ToggleableState))
        push.performTouchInput { down(center) }
        push.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Pressed"))
        compose.onNodeWithTag("mic-mute").assert(
            SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off))
        compose.runOnIdle { assertEquals(1, presses); assertEquals(0, releases); ui = ui.copy(micOpen = true) }
        push.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Live now. Release to mute"))
        push.performTouchInput { up() }
        push.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Ready"))
        push.performTouchInput { down(center); cancel() }
        push.performTouchInput { down(center); moveTo(Offset(-50f, -50f)); up() }
        push.performTouchInput { down(0, center); down(1, center + Offset(10f, 0f)); up(0); up(1) }
        compose.runOnIdle {
            assertEquals(4, presses)
            assertEquals(4, releases)
            assertFalse(ui.holding)
            assertTrue(ui.micMuted)
            ui = ready.copy(canHold = false, micMuted = false, micOpen = true)
        }
        push.assertIsNotEnabled().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Live now. Microphone open"))
            .performTouchInput { click() }
        compose.runOnIdle { assertEquals(4, presses); assertEquals(4, releases) }
    }

    @Test fun disposingRockerReleasesAndReentryRequiresANewPress() {
        var ui by mutableStateOf(ready)
        var visible by mutableStateOf(true)
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme {
                Box(Modifier.fillMaxSize()) {
                    if (visible) PreviewControls(ui, {}, {
                        presses++
                        ui = ui.copy(holding = true, micOpen = true)
                    }, {
                        releases++
                        ui = ui.copy(holding = false, micOpen = false)
                    }, Modifier.width(312.dp))
                }
            }
        }
        val initialBounds = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { assertTrue(ui.holding); visible = false }
        compose.waitForIdle()
        compose.onNodeWithTag("hold-to-talk").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(1, presses)
            assertEquals(1, releases)
            assertFalse(ui.holding)
            assertFalse(ui.micOpen)
            visible = true
        }
        val replacement = compose.onNodeWithTag("hold-to-talk")
        assertEquals(initialBounds, replacement.getUnclippedBoundsInRoot())
        replacement.assertIsEnabled()
        // Re-entry cannot adopt the finger that belonged to the disposed surface.
        replacement.performTouchInput { moveTo(center); up() }
        compose.runOnIdle { assertEquals(1, presses); assertEquals(1, releases); assertFalse(ui.holding) }
        replacement.performTouchInput { down(center) }
        compose.runOnIdle { assertEquals(2, presses); assertEquals(1, releases); assertTrue(ui.holding) }
        replacement.performTouchInput { up() }
        compose.runOnIdle { assertEquals(2, releases); assertFalse(ui.holding); assertFalse(ui.micOpen) }
    }

    @Test fun rockerOffersExplicitAccessibilityStartAndStopWithoutAToggleState() {
        var ui by mutableStateOf(ready)
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme {
                PreviewControls(ui, {}, {
                    presses++
                    ui = ui.copy(holding = true, micOpen = false)
                }, {
                    releases++
                    ui = ui.copy(holding = false, micOpen = false)
                }, Modifier.width(312.dp))
            }
        }
        val push = compose.onNodeWithTag("hold-to-talk")
        val start = push.fetchSemanticsNode().config[SemanticsActions.CustomActions].single()
        assertEquals("Start talking", start.label)
        compose.runOnIdle { assertTrue(start.action()) }
        push.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Pressed"))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ToggleableState))
        val stop = push.fetchSemanticsNode().config[SemanticsActions.CustomActions].single()
        assertEquals("Stop talking", stop.label)
        compose.runOnIdle { assertTrue(stop.action()) }
        compose.runOnIdle { assertEquals(1, presses); assertEquals(1, releases); assertFalse(ui.holding) }
    }
}
