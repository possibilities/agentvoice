package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewSwitchAudioTest {
    @get:Rule val compose = createComposeRule()
    private class Output : PreviewSwitchOutput {
        val cues = mutableListOf<PreviewSwitchCue>()
        override fun play(family: String, cue: PreviewSwitchCue, gain: Float): Boolean { cues.add(cue); return true }
        override fun stop() = Unit
    }

    @Test fun realPreviewGesturesDispatchAcceptedClicksAndOrdinaryReleaseOnly() {
        compose.mainClock.autoAdvance = false
        var state by mutableStateOf(PersonaPreviewState(sounds = PreviewSounds("rocker-29", 70)))
        var visible by mutableStateOf(true)
        val output = Output()
        compose.setContent { if (visible) VoiceTheme { PersonaPreview(state, soundOutput = output) { state = it } } }
        compose.mainClock.advanceTimeBy(1000)
        val push = compose.onNodeWithTag("hold-to-talk")
        compose.onNodeWithTag("speaker-mute").performTouchInput { click() }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("mic-mute").performTouchInput { click() }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("mic-mute").performTouchInput { click() }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertTrue(state.micMuted); assertEquals(listOf(PreviewSwitchCue.ToggleOff, PreviewSwitchCue.ToggleOn, PreviewSwitchCue.ToggleOff), output.cues); output.cues.clear() }
        push.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertTrue(state.holding); assertEquals(listOf(PreviewSwitchCue.Down), output.cues) }
        push.performTouchInput { up() }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertFalse(state.holding); assertEquals(listOf(PreviewSwitchCue.Down, PreviewSwitchCue.Up), output.cues); output.cues.clear() }
        for (ending in listOf("cancel", "exit", "second")) {
            push.performTouchInput { down(center) }
            compose.mainClock.advanceTimeByFrame()
            push.performTouchInput {
                when (ending) {
                    "cancel" -> cancel()
                    "exit" -> { moveTo(Offset(-80f, -80f)); up() }
                    else -> { down(1, center + Offset(10f, 0f)); up(0); up(1) }
                }
            }
            compose.mainClock.advanceTimeByFrame()
            compose.runOnIdle { assertFalse(state.holding); assertEquals(ending, listOf(PreviewSwitchCue.Down), output.cues); output.cues.clear() }
        }
        // Tuning while held cancels its sound pair, never replaying on a subsequent release.
        push.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { state = state.copy(sounds = PreviewSounds("rocker-13", 30)) }
        compose.mainClock.advanceTimeByFrame()
        push.performTouchInput { up() }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertEquals(listOf(PreviewSwitchCue.Down), output.cues); output.cues.clear() }
        // An already-open microphone acknowledges touch visually, without a PTT cue.
        compose.runOnIdle { state = state.copy(micMuted = false, holding = false) }
        compose.mainClock.advanceTimeByFrame()
        push.performTouchInput { down(center); up() }
        compose.runOnIdle { assertTrue(output.cues.isEmpty()); state = state.copy(micMuted = true) }
        compose.mainClock.advanceTimeByFrame()
        push.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { visible = false }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertFalse(state.holding); assertEquals(listOf(PreviewSwitchCue.Down), output.cues) }
    }

    @Test fun allBundledCuesDecodeAndAllocateNativeStreamsWithoutLateReplay() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        lateinit var pool: PreviewSwitchPool
        compose.runOnIdle { pool = PreviewSwitchPool(context) }
        try {
            compose.waitUntil(5000) { pool.readyCount == 8 }
            compose.runOnIdle {
                for (family in listOf("rocker-29", "rocker-13")) for (cue in PreviewSwitchCue.entries) {
                    assertTrue("$family $cue", pool.play(family, cue, .05f))
                    pool.stop()
                }
                assertFalse(pool.play("off", PreviewSwitchCue.ToggleOn, .7f))
                assertFalse(pool.play("rocker-29", PreviewSwitchCue.ToggleOn, 0f))
                pool.close()
                assertFalse(pool.play("rocker-29", PreviewSwitchCue.Up, .7f))
            }
        } finally { compose.runOnIdle { pool.close() } }
    }
}
