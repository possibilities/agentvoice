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

    @Test fun compositionChangesKeepBothNativeRenderersAndControlGeometry() {
        var state by mutableStateOf(PersonaPreviewState(mode = "idle"))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        fun nativeView() = (compose.activity.window.decorView as ViewGroup).descendants
            .filterIsInstance<RiveAnimationView>().single()
        val stage = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val talk = compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot()
        for (variant in listOf("original", "contained")) {
            compose.runOnIdle { state = state.copy(halo = state.halo.copy(variant = variant)) }
            val view = compose.runOnIdle { nativeView() }
            for (composition in listOf("dock", "yoke", "socket", "traces", "open")) {
                compose.runOnIdle { state = state.copy(design = state.design.copy(composition = composition, hold = "rocker")) }
                compose.runOnIdle { assertSame("Composition must not replay the native entry animation", view, nativeView()) }
                assertEquals(stage, compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot())
                assertEquals(talk, compose.onNodeWithTag("hold-to-talk").getUnclippedBoundsInRoot())
                compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
                compose.runOnIdle { assertTrue(state.holding) }
                compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
                compose.runOnIdle { assertFalse(state.holding); assertFalse(state.ui().micOpen) }
            }
        }
    }
}
