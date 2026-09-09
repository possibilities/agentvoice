package com.arthack.agentvoice

import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
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

    @Test fun rockerWaitsForConfirmationAndReleasesOnUpCancelExitAndSecondPointer() {
        var ui by mutableStateOf(ready)
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme {
                PreviewControls(ui, "rockers", "rocker", {}, {
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
        push.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Opening microphone"))
        compose.onNodeWithTag("mic-mute").assert(
            SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off))
        compose.runOnIdle { assertEquals(1, presses); assertEquals(0, releases); ui = ui.copy(micOpen = true) }
        push.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Release to mute"))
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
        push.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(4, presses); assertEquals(4, releases) }
    }

    @Test fun changingPushStyleReleasesTheCurrentOwnerAndCannotRearmTheRemainingFinger() {
        var ui by mutableStateOf(ready)
        var style by mutableStateOf("trigger")
        var visible by mutableStateOf(true)
        var presses = 0
        val releasedWith = mutableListOf<String>()
        compose.setContent {
            val renderedStyle = style
            if (visible) VoiceTheme {
                PreviewControls(ui, "keycaps", style, {}, {
                    presses++
                    ui = ui.copy(holding = true, micOpen = true)
                }, {
                    releasedWith.add(renderedStyle)
                    ui = ui.copy(holding = false, micOpen = false)
                }, Modifier.width(312.dp))
            }
        }
        val initialBounds = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        for ((index, next) in listOf("rocker", "trigger", "rocker").withIndex()) {
            compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
            compose.runOnIdle { assertTrue(ui.holding); style = next }
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(index + 1, releasedWith.size)
                assertEquals(next, releasedWith.last())
                assertFalse(ui.holding)
            }
            val replacement = compose.onNodeWithTag("hold-to-talk")
            assertEquals(initialBounds, replacement.getUnclippedBoundsInRoot())
            replacement.performTouchInput { moveTo(center); up() }
            compose.runOnIdle { assertEquals(index + 1, presses); assertEquals(presses, releasedWith.size) }
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { visible = false }
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(4, presses)
            assertEquals(4, releasedWith.size)
            assertEquals("rocker", releasedWith.last())
            assertFalse(ui.holding)
        }
    }

    @Test fun rockerOffersExplicitAccessibilityStartAndStopWithoutAToggleState() {
        var ui by mutableStateOf(ready)
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme {
                PreviewControls(ui, "keycaps", "rocker", {}, {
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
        push.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Opening microphone"))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ToggleableState))
        val stop = push.fetchSemanticsNode().config[SemanticsActions.CustomActions].single()
        assertEquals("Stop talking", stop.label)
        compose.runOnIdle { assertTrue(stop.action()) }
        compose.runOnIdle { assertEquals(1, presses); assertEquals(1, releases); assertFalse(ui.holding) }
    }
}
