@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.descendants
import app.rive.runtime.kotlin.core.Rive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewTideThemeTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun tideMovesInTheApertureAndReducedMotionStopsItImmediately() {
        compose.mainClock.autoAdvance = false
        var eligible by mutableStateOf(true)
        var allowed by mutableStateOf(true)
        var radius by mutableStateOf(45.dp)
        val phase = mutableFloatStateOf(0f)
        compose.setContent {
            Box(Modifier.size(320.dp).background(VoiceInk.ground)) {
                PreviewMutedPresence(eligible, allowed, phase, 320.dp, (-22).dp, radius)
            }
        }
        compose.mainClock.advanceTimeBy(500)
        fun image(): List<Int> {
            val map = compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).captureToImage().toPixelMap()
            return List(map.width * map.height) { index -> map[index % map.width, index / map.width].hashCode() }
        }
        val first = image()
        compose.runOnIdle { phase.floatValue = .5f }
        compose.mainClock.advanceTimeBy(32)
        assertNotEquals("The shared tide must move the rendered word", first, image())
        compose.runOnIdle { allowed = false }
        compose.mainClock.advanceTimeBy(32)
        val still = image()
        compose.runOnIdle { phase.floatValue = .25f }
        compose.mainClock.advanceTimeBy(800)
        assertEquals(still, image())
        compose.runOnIdle { eligible = false }
        compose.mainClock.advanceTimeBy(16)
        compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).assertDoesNotExist()
        compose.runOnIdle { eligible = true; radius = 12.dp }
        compose.mainClock.advanceTimeBy(16)
        compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun mutedClockRunsWithoutLightAndStopsForBackgroundOrOpenChannels() {
        compose.mainClock.autoAdvance = false
        var ui by mutableStateOf(CallUi(connected = true, micMuted = true, speakerMuted = true))
        var foreground by mutableStateOf(true)
        lateinit var scene: PreviewSpiritScene
        compose.setContent {
            scene = rememberPreviewSpirit(ui, PreviewSpirit(), PreviewHalo(), "steady", motionAllowed = true,
                foreground = foreground, mutedPresence = previewMutedEligible(ui, foreground))
        }
        compose.mainClock.advanceTimeBy(1000)
        compose.runOnIdle {
            assertTrue(scene.phaseTurns.value > 0f)
            assertEquals(PreviewButtonLight(), scene.light.value)
            assertEquals(PreviewAmbientFrame(), scene.ambient.value)
            foreground = false
        }
        compose.mainClock.advanceTimeBy(50)
        compose.runOnIdle { assertEquals(0f, scene.phaseTurns.value); foreground = true; ui = ui.copy(micOpen = true, holding = true) }
        compose.mainClock.advanceTimeBy(1000)
        compose.runOnIdle { assertEquals(0f, scene.phaseTurns.value) }
    }

    @Test fun themeChangesRetainHeldPointerNativeViewAndManualPersonaBounds() {
        compose.mainClock.autoAdvance = false
        var ui by mutableStateOf(CallUi(connected = true, micMuted = true, speakerMuted = true, canHold = true))
        var theme by mutableStateOf("bright")
        var spacing by mutableStateOf(PreviewSpacing())
        var starts = 0
        var stops = 0
        compose.setContent {
            VoiceTheme {
                Box(Modifier.requiredSize(320.dp, 740.dp)) {
                    PreviewStudioScreen(ui, PreviewDesign(spacing = spacing), PersonaPlacement(offsetY = 0.dp),
                        {}, { starts++; ui = ui.copy(holding = true, micOpen = true) },
                        { stops++; ui = ui.copy(holding = false, micOpen = false) }, {},
                        halo = PreviewHalo(variant = "contained"), theme = theme)
                }
            }
        }
        compose.mainClock.advanceTimeBy(600)
        val stage = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val native = compose.runOnIdle {
            (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<CompactHaloAnimationView>().single()
        }
        compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).assertExists()
        val push = compose.onNodeWithTag("hold-to-talk")
        push.performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(32)
        compose.onNodeWithTag("preview-muted-presence", useUnmergedTree = true).assertDoesNotExist()
        for (next in listOf("quiet", "grayscale", "bright")) {
            compose.runOnIdle { theme = next }
            compose.mainClock.advanceTimeBy(50)
            compose.runOnIdle { assertTrue(ui.holding); assertEquals(1, starts); assertEquals(0, stops) }
        }
        push.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(32)
        compose.runOnIdle { assertEquals(1, stops); spacing = PreviewSpacing(sideMarginPercent = 160, sectionGapDp = 40, pushGapDp = 40) }
        compose.mainClock.advanceTimeBy(650)
        assertEquals(stage, compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot())
        compose.runOnIdle {
            assertSame(native, (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<CompactHaloAnimationView>().single())
        }
    }

    @Test fun originalThemeRecolorsPreservePausedSilhouetteAndActuallyDrawGrayscale() {
        lateinit var view: HaloAnimationView
        compose.setContent {
            AndroidView(factory = { context ->
                Rive.init(context)
                (LayoutInflater.from(context).inflate(R.layout.persona_halo, null, false) as HaloAnimationView).also {
                    view = it
                    it.present(PersonaState.Listening, PersonaColors().listening, false)
                }
            }, modifier = Modifier.size(240.dp), onRelease = { it.pause() })
        }
        fun pixels(): IntArray? = compose.runOnIdle {
            view.getBitmap(256, 256)?.let { bitmap ->
                IntArray(256 * 256).also { bitmap.getPixels(it, 0, 256, 0, 0, 256, 256); bitmap.recycle() }
            }
        }
        compose.waitUntil(5000) { pixels()?.count { (it ushr 24) > 40 }?.let { it > 100 } == true && !view.isPlaying }
        val machine = compose.runOnIdle { view.stateMachines.single() }
        val alpha = pixels()!!.map { it ushr 24 }
        for (theme in listOf(PreviewTheme.Quiet, PreviewTheme.Grayscale, PreviewTheme.Bright)) {
            val before = pixels()!!.toList()
            compose.runOnIdle { view.present(PersonaState.Listening, theme.haloArgb(PersonaColors().listening), false) }
            compose.waitUntil(3000) { !view.isPlaying && pixels()?.toList()?.let { it != before } == true }
            assertEquals("Theme must not re-settle a paused native pose", alpha, pixels()!!.map { it ushr 24 })
            compose.runOnIdle { assertSame(machine, view.stateMachines.single()) }
            if (theme == PreviewTheme.Grayscale) {
                for (pixel in pixels()!!.filter { (it ushr 24) >= 40 }) {
                    val r = (pixel shr 16) and 255; val g = (pixel shr 8) and 255; val b = pixel and 255
                    assertTrue("Native grayscale has residual chroma", maxOf(r, g, b) - minOf(r, g, b) <= 1)
                }
            }
        }
    }
}
