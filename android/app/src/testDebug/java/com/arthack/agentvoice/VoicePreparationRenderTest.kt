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

/** Native Compose pixels and gestures; Rive remains a device-validation boundary. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class VoicePreparationRenderTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun litPreparationRemainsDisabledAndLeavesRecoveryAndLiveActionsTruthful() {
        var presentation by mutableStateOf(VoicePresentation.Preparing)
        var ui by mutableStateOf(CallUi())
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                CompositionLocalProvider(LocalVoicePresentation provides presentation) {
                    Column(Modifier.fillMaxSize().background(VoiceInk.ground).padding(24.dp)) {
                        PreviewConnectionNotice(presentation.connection, innerRadius = 160.dp,
                            presentation = presentation, onCancel = if (ui.running && !ui.connected) ({ actions += "cancel" }) else null)
                        Spacer(Modifier.height(60.dp))
                        PreviewControls(ui, { actions += it }, { actions += "hold" }, {},
                            Modifier.fillMaxWidth(), controlsHeightDp = 300)
                    }
                }
            }
        }
        compose.onNodeWithText("Preparing…").assertExists()
        compose.onNodeWithTag("connection-primary-action").assertDoesNotExist()
        compose.onNodeWithTag("mic-mute").assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithTag("speaker-mute").assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithTag("hold-to-talk").assertIsNotEnabled().performTouchInput { down(center); advanceEventTime(250); up() }
        capture("preparing")
        compose.runOnIdle { assertTrue(actions.isEmpty()); ui = CallUi(running = true); presentation = VoicePresentation.Connecting }
        compose.onNodeWithTag("connection-primary-action").assertIsEnabled().performClick()
        capture("connecting")
        compose.runOnIdle { assertEquals(listOf("cancel"), actions); ui = CallUi(); presentation = VoicePresentation.Disconnected }
        capture("disconnected")
        compose.runOnIdle { ui = CallUi(running = true, connected = true, controlsPending = true); presentation = VoicePresentation.Connected }
        compose.onNodeWithTag("preview-connection-notice").assertDoesNotExist()
        compose.onNodeWithTag("mic-mute").assertIsNotEnabled()
        compose.runOnIdle { ui = ui.copy(controlsPending = false) }
        compose.onNodeWithTag("mic-mute").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("cancel", "mic"), actions) }
    }

    @Test fun retainedDisconnectedAttemptOffersEndAndExplainsRecovery() {
        val ui = CallUi(running = true, hasReachedLive = true, phase = "Connecting")
        val presentation = voicePresentation(ui)
        var ended = false
        compose.setContent {
            VoiceTheme {
                PreviewConnectionNotice(presentation.connection, innerRadius = 160.dp,
                    presentation = presentation, onCancel = { ended = true })
            }
        }
        compose.onNodeWithText("Disconnected").assertExists()
        compose.onNodeWithText("Cancel").assertDoesNotExist()
        compose.onNodeWithText("Connect").assertDoesNotExist()
        compose.onNodeWithText("End attempt").assertExists().performClick()
        compose.runOnIdle { assertTrue(ended) }
    }

    @Test fun compactLostAttemptDetailsNeverPromiseASecondConnection() {
        compose.setContent {
            VoiceTheme {
                PreviewConnectionNotice("disconnected", innerRadius = 40.dp, onCancel = {})
            }
        }
        compose.onNodeWithTag("connection-compact").performClick()
        compose.onNodeWithText("Voice connection was lost. End this attempt before reconnecting.").assertExists()
        compose.onNodeWithText("End attempt").assertExists()
        compose.onNodeWithText("Connect when you’re ready.").assertDoesNotExist()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            val output = File("build/reports/voice-preparation-renders").apply { mkdirs() }
            File(output, "$name.png").outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            bitmap.recycle()
        }
    }
}
