package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewStudioTest {
    @get:Rule val compose = createComposeRule()
    private val ready = CallUi(running = true, connected = true, phase = "Connected", micMuted = true,
        speakerMuted = false, speakerOpen = true, canHold = true)

    @Test fun directionsKeepTargetsFixedAndSwitchBackToOriginalWithoutReverting() {
        var state by mutableStateOf(PersonaPreviewState(mode = "idle", design = PreviewDesign("studio")))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        val before = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        val designs = listOf(PreviewDesign("studio"), PreviewDesign("studio", "drawer", "rockers", "trigger"),
            PreviewDesign("studio", "none", "keycaps", "keycap"), PreviewDesign("studio", "quiet", "keycaps", "beam"))
        for (design in designs) {
            compose.runOnIdle { state = state.select("idle").copy(design = design) }
            assertEquals(before, compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot())
            compose.onNodeWithTag("mic-mute").assertContentDescriptionEquals("YOU microphone").performClick()
            compose.runOnIdle { assertFalse(state.micMuted); assertEquals("listening", state.mode) }
            compose.onNodeWithTag("speaker-mute").assertContentDescriptionEquals("AGENT speaker").performClick()
            compose.runOnIdle { assertTrue(state.speakerMuted); assertFalse(state.micMuted) }
        }
        compose.runOnIdle { state = state.copy(design = PreviewDesign()) }
        compose.onNodeWithTag("connection-status").assertExists()
        compose.runOnIdle { state = state.copy(design = PreviewDesign("studio")) }
        compose.onNodeWithTag("preview-controls").assertExists()
        compose.runOnIdle { assertEquals("studio", state.design.layout) }
    }

    @Test fun everyTalkSurfaceReleasesOutsideOnCancelAndOnSecondPointer() {
        var ui by mutableStateOf(ready)
        var style by mutableStateOf("beam")
        var presses = 0
        var releases = 0
        compose.setContent {
            VoiceTheme { PreviewControls(ui, "keycaps", style, {},
                { presses++; ui = ui.copy(holding = true, micOpen = true) },
                { releases++; ui = ui.copy(holding = false, micOpen = false) }) }
        }
        for (next in listOf("beam", "trigger", "keycap")) {
            compose.runOnIdle { style = next }
            val hold = compose.onNodeWithTag("hold-to-talk")
            hold.performTouchInput { down(center) }
            compose.onNodeWithTag("mic-mute").assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off))
            hold.performTouchInput { moveTo(Offset(-50f, -50f)); up() }
            hold.performTouchInput { down(center); cancel() }
            hold.performTouchInput { down(0, center); down(1, center + Offset(10f, 0f)); up(0); up(1) }
            compose.runOnIdle { assertEquals(presses, releases); assertTrue(ui.micMuted); assertFalse(ui.holding) }
        }
        compose.runOnIdle { assertEquals(9, presses); ui = ready.copy(canHold = false, micMuted = false, micOpen = true) }
        compose.onNodeWithTag("hold-to-talk").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(9, presses) }
    }

    @Test fun headerMovesPersonaCenterWithoutResizingItOrMovingTheTalkTarget() {
        compose.mainClock.autoAdvance = false
        compose.setContent { VoiceTheme { PreviewStudioScreen(ready, PreviewDesign("studio", "drawer"),
            PersonaPlacement(), {}, {}, {}, {}) } }
        settleHeaderTransition()
        val holdBefore = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        val stageBefore = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val headerBefore = compose.onNodeWithTag("preview-header").getUnclippedBoundsInRoot()
        compose.onNodeWithTag("preview-header-reveal").performClick()
        settleHeaderTransition()
        val stageAfter = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val headerAfter = compose.onNodeWithTag("preview-header").getUnclippedBoundsInRoot()
        val holdAfter = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        val expectedShift = ((headerAfter.bottom - headerAfter.top) - (headerBefore.bottom - headerBefore.top)).value / 2f
        val actualShift = (stageAfter.top - stageBefore.top).value
        val expandedGeometry = "header: $headerBefore -> $headerAfter; Halo: $stageBefore -> $stageAfter; " +
            "talk: $holdBefore -> $holdAfter; expected shift: ${expectedShift}dp, observed: ${actualShift}dp"
        assertTrue("Header failed to expand. $expandedGeometry", expectedShift > 0f)
        assertEquals("Talk target moved on expansion. $expandedGeometry", holdBefore, holdAfter)
        assertEquals("Halo width changed. $expandedGeometry",
            (stageBefore.right - stageBefore.left).value, (stageAfter.right - stageAfter.left).value, .5f)
        assertEquals("Halo height changed. $expandedGeometry",
            (stageBefore.bottom - stageBefore.top).value, (stageAfter.bottom - stageAfter.top).value, .5f)
        assertEquals("Halo moved horizontally. $expandedGeometry", stageBefore.left.value, stageAfter.left.value, .5f)
        assertEquals("Halo did not re-center within the uncovered region. $expandedGeometry", expectedShift, actualShift, .5f)
        compose.onNodeWithTag("preview-header-details").assertExists()
        compose.onNodeWithTag("preview-header-reveal").performClick()
        settleHeaderTransition()
        val stageCollapsed = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val headerCollapsed = compose.onNodeWithTag("preview-header").getUnclippedBoundsInRoot()
        val holdCollapsed = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        val collapsedGeometry = "header: $headerBefore -> $headerCollapsed; Halo: $stageBefore -> $stageCollapsed; " +
            "talk: $holdBefore -> $holdCollapsed"
        assertEquals("Header did not return to its collapsed geometry. $collapsedGeometry", headerBefore, headerCollapsed)
        assertEquals("Talk target moved on collapse. $collapsedGeometry", holdBefore, holdCollapsed)
        assertEquals("Halo left edge changed after collapse. $collapsedGeometry", stageBefore.left.value, stageCollapsed.left.value, .5f)
        assertEquals("Halo right edge changed after collapse. $collapsedGeometry", stageBefore.right.value, stageCollapsed.right.value, .5f)
        assertEquals("Halo top did not return after collapse. $collapsedGeometry", stageBefore.top.value, stageCollapsed.top.value, .5f)
        assertEquals("Halo bottom did not return after collapse. $collapsedGeometry", stageBefore.bottom.value, stageCollapsed.bottom.value, .5f)
    }

    private fun settleHeaderTransition() {
        // Header measurement runs in Android layout; advancing Compose's clock alone
        // does not deliver the size callback and the reservation update in one pass.
        repeat(2) {
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
        }
        compose.mainClock.advanceTimeBy(400)
        compose.waitForIdle()
    }
}
