package com.arthack.agentvoice

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Actual Canvas/Compose trace and face pixels; native Rive remains a physical-phone boundary. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w891dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PreviewTraceEnergyRenderTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun duplexFlowDrawsOnBothOrientationsAndClearsWithoutAnotherClockTick() {
        var ui by mutableStateOf(CallUi(connected = true, micMuted = false, speakerMuted = false,
            micOpen = true, speakerOpen = true))
        val light = mutableStateOf(PreviewButtonLight())
        var portrait by mutableStateOf(true)
        var side by mutableStateOf("left")
        var enabled by mutableStateOf(true)
        var showControls by mutableStateOf(true)
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                val geometry = previewOrientationGeometry(if (portrait) 360f else 780f,
                    if (portrait) 760f else 360f, if (portrait) 360f else 780f, portrait, 262f, 0f, side)
                Box(Modifier.requiredSize(if (portrait) 360.dp else 780.dp, if (portrait) 760.dp else 360.dp)
                    .background(VoiceInk.ground)) {
                    if (portrait) PreviewPersonaTraces(geometry.deckY.dp, 262.dp, geometry.deckX.dp,
                        Modifier.matchParentSize(), (geometry.stageY + geometry.diameter / 2f).dp,
                        95.dp, light = light, ui = ui, energyEnabled = enabled)
                    else PreviewLandscapeTraces(geometry, 65.dp, PreviewDesign(), Modifier.matchParentSize(),
                        light = light, ui = ui, energyEnabled = enabled)
                    if (showControls) PreviewControls(ui, { actions += it }, {}, {},
                        Modifier.offset(geometry.deckX.dp, geometry.deckY.dp).width(geometry.deckWidth.dp),
                        controlsHeightDp = 262, light = light, landscape = !portrait,
                        availableHeightDp = geometry.deckViewportHeight, mirror = side == "right")
                }
            }
        }
        val stale = PreviewButtonLight(captureEnergy = 1f, playbackEnergy = 1f, flowPhaseTurns = .42f)
        for (layout in listOf("portrait", "left", "right")) {
            compose.runOnIdle { portrait = layout == "portrait"; side = if (portrait) "left" else layout; light.value = PreviewButtonLight(); showControls = false }
            val baseline = capture("$layout-still")
            compose.runOnIdle { light.value = stale }
            val active = capture("$layout-duplex")
            assertTrue("Energy must produce visible pixels in $layout", differences(baseline, active) > 100)
            compose.runOnIdle { light.value = stale.copy(flowPhaseTurns = .65f) }
            val later = capture("$layout-later")
            assertTrue("Flow must move on existing routes", differences(active, later) > 100)
            compose.runOnIdle { showControls = true; enabled = false; light.value = PreviewButtonLight() }
            val bounds = compose.onNodeWithTag("mic-mute").fetchSemanticsNode().boundsInRoot
            val controlsBaseline = capture("$layout-controls-still")
            compose.runOnIdle { light.value = stale }
            assertTrue("Channel controls must share measured energy", differences(controlsBaseline, capture("$layout-controls-energy")) > 100)
            compose.runOnIdle { enabled = true }
            capture("$layout-controls-duplex")
            assertEquals(bounds, compose.onNodeWithTag("mic-mute").fetchSemanticsNode().boundsInRoot)
            compose.onNodeWithTag("mic-mute").performClick()
            compose.runOnIdle { ui = ui.copy(micOpen = false, speakerOpen = false); light.value = stale }
            val closed = capture("$layout-closed")
            compose.runOnIdle { light.value = PreviewButtonLight() }
            val closedBaseline = capture("$layout-closed-baseline")
            assertEquals("Stale energy cannot survive closed gates", 0, differences(closed, closedBaseline))
            compose.runOnIdle { ui = ui.copy(micOpen = true, speakerOpen = true) }
        }
        compose.runOnIdle { assertEquals(listOf("mic", "mic", "mic"), actions) }
        // A stopped lifecycle/reduced-motion draw ignores even an old nonzero trace frame.
        compose.runOnIdle { enabled = false; showControls = false; light.value = stale }
        val suspended = capture("suspended")
        compose.runOnIdle { light.value = PreviewButtonLight() }
        assertEquals(0, differences(suspended, capture("suspended-baseline")))
    }

    private fun differences(a: Bitmap, b: Bitmap): Int {
        var count = 0
        for (y in 0 until a.height) for (x in 0 until a.width) if (a.getPixel(x, y) != b.getPixel(x, y)) count++
        return count
    }

    private fun capture(name: String): Bitmap {
        compose.waitForIdle()
        lateinit var bitmap: Bitmap
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            val output = File("build/reports/trace-energy-renders").apply { mkdirs() }
            File(output, "$name.png").outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        }
        return bitmap
    }
}
