package com.arthack.agentvoice

import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.descendants
import app.rive.runtime.kotlin.RiveAnimationView
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewOrientationLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun rotationAndHandednessRetainTheNativeViewAndReleaseTheOldPointer() {
        compose.mainClock.autoAdvance = false
        var landscape by mutableStateOf(false)
        var side by mutableStateOf("left")
        var state by mutableStateOf(PersonaPreviewState(mode = "idle", halo = PreviewHalo(variant = "contained")))
        compose.setContent {
            VoiceTheme {
                Box(Modifier.requiredSize(if (landscape) 352.dp else 320.dp, if (landscape) 320.dp else 720.dp)) {
                    PreviewStudioScreen(state.ui(), state.design, state.placement,
                        onMute = { state = state.toggle(it) }, onHold = { state = state.beginHold() },
                        onRelease = { state = state.endHold() }, onExit = {}, halo = state.halo, personaSide = side)
                }
            }
        }
        compose.mainClock.advanceTimeBy(64)
        fun nativeView() = (compose.activity.window.decorView as ViewGroup).descendants
            .filterIsInstance<RiveAnimationView>().single()
        val view = compose.runOnIdle { nativeView() }
        val stage = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true)
        stage.assertWidthIsEqualTo(320.dp).assertHeightIsEqualTo(320.dp)
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { assertTrue(state.holding); landscape = true }
        compose.mainClock.advanceTimeBy(400)
        compose.runOnIdle { assertFalse(state.holding); assertSame(view, nativeView()) }
        val leftStage = stage.getUnclippedBoundsInRoot()
        val rightDeck = compose.onNodeWithTag("preview-controls").getUnclippedBoundsInRoot()
        assertEquals((leftStage.right - leftStage.left).value, (leftStage.bottom - leftStage.top).value, .1f)
        assertTrue(leftStage.right < rightDeck.left)
        compose.onRoot().performTouchInput { up() }
        compose.mainClock.advanceTimeBy(64)
        compose.runOnIdle { assertFalse(state.holding); side = "right" }
        compose.mainClock.advanceTimeBy(400)
        val rightStage = stage.getUnclippedBoundsInRoot()
        val leftDeck = compose.onNodeWithTag("preview-controls").getUnclippedBoundsInRoot()
        assertTrue(rightStage.left > leftDeck.right)
        assertEquals((leftStage.right - leftStage.left).value, (rightStage.right - rightStage.left).value, .1f)
        assertTrue(compose.onNodeWithTag("mic-mute").getUnclippedBoundsInRoot().top <
            compose.onNodeWithTag("speaker-mute").getUnclippedBoundsInRoot().top)
        compose.runOnIdle { assertSame(view, nativeView()); assertFalse(state.holding); landscape = false }
        compose.mainClock.advanceTimeBy(400)
        stage.assertWidthIsEqualTo(320.dp).assertHeightIsEqualTo(320.dp)
        compose.runOnIdle { assertSame(view, nativeView()); assertFalse(state.holding) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { assertTrue(state.holding) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        compose.runOnIdle { assertFalse(state.holding) }
    }
}
