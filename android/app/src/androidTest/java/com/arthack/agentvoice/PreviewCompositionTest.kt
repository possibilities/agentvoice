package com.arthack.agentvoice

import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.descendants
import app.rive.runtime.kotlin.RiveAnimationView
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewCompositionTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun traceVariationsAndAmbientFramesKeepBothNativeRenderersAndHeldControls() {
        compose.mainClock.autoAdvance = false
        var state by mutableStateOf(PersonaPreviewState(mode = "idle"))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        compose.mainClock.advanceTimeBy(64)
        fun nativeView() = (compose.activity.window.decorView as ViewGroup).descendants
            .filterIsInstance<RiveAnimationView>().single()
        val stage = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val talk = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        for (variant in listOf("original", "contained")) {
            compose.runOnIdle { state = state.copy(halo = state.halo.copy(variant = variant)) }
            compose.mainClock.advanceTimeBy(64)
            val view = compose.runOnIdle { nativeView() }
            for (pattern in listOf("parallel", "splayed", "circuit")) {
                compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
                compose.mainClock.advanceTimeBy(64)
                compose.runOnIdle { assertTrue(state.holding) }
                compose.runOnIdle { state = state.copy(design = state.design.copy(traces = PreviewTraces(pattern, 150, 250, 100, 100))) }
                compose.mainClock.advanceTimeBy(64)
                compose.runOnIdle { assertSame("Composition must not replay the native entry animation", view, nativeView()) }
                assertEquals(stage, compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot())
                assertEquals(talk, compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot())
                compose.mainClock.advanceTimeBy(1200)
                compose.runOnIdle { assertTrue(state.holding); assertSame(view, nativeView()) }
                compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
                compose.mainClock.advanceTimeBy(64)
                compose.runOnIdle { assertFalse(state.holding); assertFalse(state.ui().micOpen) }
            }
        }
    }
}
