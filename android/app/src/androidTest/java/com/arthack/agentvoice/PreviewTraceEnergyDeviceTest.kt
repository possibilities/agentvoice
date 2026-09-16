package com.arthack.agentvoice

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.compose.foundation.layout.*
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Isolated synthetic scene: exercises native Rive without opening the Studio draft or any media. */
class PreviewTraceEnergyDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun nativeSceneRetainsGeometryAndAccessibleGatesDuringDuplexFlow() {
        compose.mainClock.autoAdvance = false
        val arguments = InstrumentationRegistry.getArguments()
        val side = arguments.getString("traceSide") ?: "left"
        val variant = arguments.getString("traceVariant") ?: "contained"
        val label = arguments.getString("traceLabel") ?: "$variant-$side"
        val duplex = CallUi(connected = true, micMuted = false, speakerMuted = false,
            micOpen = true, speakerOpen = true, inputLevel = .2f, outputLevel = .14f)
        var ui by mutableStateOf(duplex)
        var connection by mutableStateOf("connected")
        compose.activityRule.scenario.onActivity { activity ->
            activity.enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
                navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }
        compose.setContent {
            val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
            val layout = if (landscape) ShippingDesign.landscape else ShippingDesign.portrait
            VoiceTheme {
                PreviewStudioScreen(ui, layout.design, layout.placement,
                    onMute = { channel -> ui = if (channel == "mic") ui.copy(micMuted = true, micOpen = false)
                        else ui.copy(speakerMuted = true, speakerOpen = false) },
                    onHold = {}, onRelease = {}, onExit = {}, connection = connection,
                    halo = layout.halo.copy(variant = variant), spirit = layout.spirit,
                    personaSide = side, mutedPresence = "off", handleBack = false,
                    horizontalOffsetDp = if (side == layout.personaSide) layout.horizontalOffsetDp else -layout.horizontalOffsetDp,
                    icons = ShippingDesign.icons,
                    contentWindowInsets = WindowInsets.displayCutout.union(WindowInsets.waterfall)
                        .union(WindowInsets.captionBar).union(WindowInsets.ime))
            }
        }
        compose.mainClock.advanceTimeBy(800)
        val bounds = listOf("mic-mute", "speaker-mute", "hold-to-talk").map {
            compose.onNodeWithTag(it).getUnclippedBoundsInRoot()
        }
        capture("$label-duplex-a")
        compose.mainClock.advanceTimeBy(400)
        capture("$label-duplex-b")
        assertEquals(bounds, listOf("mic-mute", "speaker-mute", "hold-to-talk").map {
            compose.onNodeWithTag(it).getUnclippedBoundsInRoot()
        })
        compose.onNodeWithContentDescription("HUMAN microphone").assertIsEnabled().performClick()
        compose.onNodeWithContentDescription("AGENT speaker").assertIsEnabled().performClick()
        compose.mainClock.advanceTimeBy(32)
        compose.runOnIdle { assertFalse(ui.micOpen); assertFalse(ui.speakerOpen) }
        capture("$label-closed")
        compose.runOnIdle { ui = CallUi(running = true); connection = "connecting" }
        compose.mainClock.advanceTimeBy(64)
        compose.onNodeWithTag("mic-mute").assertIsNotEnabled()
        compose.onNodeWithTag("speaker-mute").assertIsNotEnabled()
        capture("$label-connecting")
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        // Native Rive has its own renderer; give its already-requested pose a bounded settle.
        Thread.sleep(250)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        val output = File(instrumentation.targetContext.cacheDir, "trace-energy-validation").apply { mkdirs() }
        File(output, "$name.png").outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
    }
}
