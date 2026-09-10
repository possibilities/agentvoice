package com.arthack.agentvoice

import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.descendants
import app.rive.runtime.kotlin.RiveAnimationView
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewMutedTuningRenderTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun largerLighterWordActuallyDrawsAndRippleRespectsReducedMotion() {
        compose.mainClock.autoAdvance = false
        var tuning by mutableStateOf(PreviewMutedTuning(driftPercent = 0))
        var allowed by mutableStateOf(true)
        val phase = mutableFloatStateOf(0f)
        compose.setContent {
            Box(Modifier.size(320.dp).background(VoiceInk.ground)) {
                PreviewMutedPresence(true, allowed, phase, 320.dp, 0.dp, 100.dp, tuning = tuning)
            }
        }
        compose.mainClock.advanceTimeBy(600)
        fun pixels(): List<Float> {
            val image = compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).captureToImage().toPixelMap()
            return List(image.width * image.height) { image[it % image.width, it / image.width].red }
        }
        val small = pixels()
        compose.runOnIdle { tuning = tuning.copy(brightnessPercent = -75) }
        compose.mainClock.advanceTimeBy(32)
        val dimmed = pixels()
        assertTrue("Negative brightness dims actual ink", dimmed.max() < small.max() * .5f)
        compose.runOnIdle { tuning = tuning.copy(brightnessPercent = -100) }
        compose.mainClock.advanceTimeBy(32)
        assertTrue("Minimum brightness removes visible ink", pixels().max() < .04f)
        compose.runOnIdle { tuning = tuning.copy(textSizeSp = 32, brightnessPercent = 100) }
        compose.mainClock.advanceTimeBy(32)
        val large = pixels()
        assertTrue("Size changes rendered type", large.count { it > .3f } > small.count { it > .3f } * 2)
        assertTrue("Brightness lightens ink", large.max() > small.max() + .2f)
        compose.runOnIdle { tuning = tuning.copy(motion = "ripple", driftPercent = 300, breathPercent = 100) }
        compose.mainClock.advanceTimeBy(32)
        val first = pixels()
        compose.runOnIdle { phase.floatValue = .4f }
        compose.mainClock.advanceTimeBy(32)
        assertNotEquals(first, pixels())
        compose.runOnIdle { allowed = false }
        compose.mainClock.advanceTimeBy(32)
        val still = pixels()
        compose.runOnIdle { phase.floatValue = .8f }
        compose.mainClock.advanceTimeBy(1000)
        assertEquals(still, pixels())
    }

    @Test fun centerChoicesKeepHaloAndHeldPttWhileReflectingTheEffectiveGate() {
        compose.mainClock.autoAdvance = false
        var state by mutableStateOf(PersonaPreviewState(mode = "idle", speakerMuted = true,
            mutedPresence = "words", presenceScope = "both-muted"))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        compose.mainClock.advanceTimeBy(700)
        fun nativeView() = (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single()
        val native = compose.runOnIdle { nativeView() }
        val stage = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        compose.onNodeWithTag("preview-center-indicator", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(32)
        compose.onNodeWithTag("preview-center-indicator", useUnmergedTree = true).assertDoesNotExist()
        for (style in listOf("channels", "labeled", "contacts", "words")) {
            compose.runOnIdle { state = state.copy(mutedPresence = style, presenceScope = "always") }
            compose.mainClock.advanceTimeBy(32)
            compose.onNodeWithTag("preview-center-indicator", useUnmergedTree = true).assertExists()
            compose.runOnIdle { assertTrue(state.holding); assertTrue(state.ui().micOpen); assertSame(native, nativeView()) }
            assertEquals(stage, compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot())
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        compose.mainClock.advanceTimeBy(32)
        compose.runOnIdle { assertFalse(state.holding); assertFalse(state.ui().micOpen); assertSame(native, nativeView()) }
    }

    @Test fun fullSceneFitsLargeTypeAndTuningDoesNotReplaceHaloOrMovePersona() {
        compose.mainClock.autoAdvance = false
        var state by mutableStateOf(PersonaPreviewState(mode = "idle", speakerMuted = true, design = PreviewDesign(),
            placement = historicalPortraitLayout().placement, halo = PreviewHalo(variant = "contained")))
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        compose.mainClock.advanceTimeBy(700)
        fun nativeView() = (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single()
        val native = compose.runOnIdle { nativeView() }
        val stage = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        for (motion in listOf("float", "ripple")) {
            compose.runOnIdle { state = state.copy(mutedTuning = PreviewMutedTuning(32, 100, 300, 100, 6, motion)) }
            compose.mainClock.advanceTimeBy(1000)
            compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).assertExists()
            assertEquals(stage, compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot())
            compose.runOnIdle { assertSame(native, nativeView()) }
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(32)
        compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).assertDoesNotExist()
        compose.runOnIdle { assertTrue(state.holding); assertSame(native, nativeView()) }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        compose.mainClock.advanceTimeBy(600)
        compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).assertExists()
    }
}
