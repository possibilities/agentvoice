package com.arthack.agentvoice

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Actual Compose pixels, without a device, emulator, network, microphone or credentials. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectionScreenRenderTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun savedServerStatesRenderAndKeepActionsScoped() {
        var profiles by mutableStateOf(emptyList<ServerProfile>())
        var ui by mutableStateOf(CallUi())
        var busy by mutableStateOf<String?>(null)
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(ui, profiles.isNotEmpty(), {}, { actions += "return" }, {}, {},
                    profiles = profiles, selectedProfileId = "one", attemptedProfileId = "one",
                    busyProfileId = busy, onConnectProfile = { actions += "connect:$it" },
                    onForgetProfile = { actions += "forget:$it" })
            }
        }
        capture("empty")
        compose.onNodeWithTag("connection-scan").assertExists()
        compose.runOnIdle { profiles = fixtures.take(1) }
        capture("single")
        compose.runOnIdle { profiles = fixtures }
        capture("multiple")
        compose.onNodeWithTag("connection-connect-two").performClick()
        compose.runOnIdle { check(actions == listOf("connect:two")) }
        compose.runOnIdle { ui = CallUi(running = true, connected = true) }
        capture("current")
        compose.onNodeWithTag("connection-return").performClick()
        compose.runOnIdle { check(actions.last() == "return") }
        compose.runOnIdle { ui = CallUi(message = "Private diagnostic") }
        capture("error")
        compose.onNodeWithText("Private diagnostic").assertDoesNotExist()
        compose.runOnIdle { busy = "two" }
        capture("switching")
        compose.onNodeWithTag("connection-connect").assertIsNotEnabled()
        compose.onNodeWithTag("connection-connect-two").assertIsNotEnabled()
        compose.onNodeWithTag("connection-menu-one").assertIsNotEnabled()
        compose.runOnIdle {
            busy = null
            ui = CallUi()
            profiles = fixtures + ServerProfile("three", "Server 3", "wss://other.example/v2/client", ServerProfileState.PENDING)
        }
        compose.onNodeWithTag("connection-finish-pairing").performScrollTo().assertIsDisplayed()
        capture("pending")
    }

    @Test fun retainedCallKeepsControlsWhenSavedAccessCannotBeOpened() {
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(CallUi(running = true, connected = true), false, {},
                    { actions += "return" }, { actions += "disconnect" }, {},
                    profiles = emptyList(), attemptedProfileId = "retained",
                    accessMessage = "Saved servers couldn’t be opened. Your call is still active.",
                    onRetryAccess = { actions += "reload" }, onForgetProfile = {})
            }
        }
        compose.onNodeWithText("Current call").assertIsDisplayed()
        compose.onNodeWithTag("connection-return").assertIsDisplayed().performClick()
        compose.onNodeWithTag("connection-disconnect").assertIsDisplayed().performClick()
        compose.onNodeWithTag("connection-scan").assertDoesNotExist()
        compose.onNodeWithTag("connection-menu-retained").assertDoesNotExist()
        compose.runOnIdle { check(actions == listOf("return", "disconnect")) }
        capture("storage-error-active-call")
    }

    @Test fun staleProfilesCannotBeUsedWhileAccessIsUnavailableButCurrentCallCan() {
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(CallUi(running = true, connected = true), true, {}, {}, {}, {},
                    profiles = fixtures + ServerProfile("three", "Server 3", "wss://other.example/v2/client", ServerProfileState.PENDING),
                    attemptedProfileId = "one", selectedProfileId = "one",
                    accessMessage = "Opening saved servers…", onConnectProfile = {}, onForgetProfile = {})
            }
        }
        compose.onNodeWithTag("connection-return").assertIsEnabled()
        compose.onNodeWithTag("connection-disconnect").assertIsEnabled()
        compose.onNodeWithTag("connection-connect-two").assertIsNotEnabled()
        compose.onNodeWithTag("connection-finish-pairing").assertIsNotEnabled()
        compose.onNodeWithTag("connection-scan").assertDoesNotExist()
        compose.onNodeWithTag("connection-menu-one").assertDoesNotExist()
    }

    @Test
    @Config(sdk = [35], qualifiers = "w891dp-h411dp-land-xhdpi")
    fun landscapeKeepsLongEndpointsAndLargeTextScrollable() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 1.5f)) {
                VoiceTheme {
                    ConnectionScreen(CallUi(), true, {}, {}, {}, {},
                        profiles = listOf(ServerProfile("one", "Server 1",
                            "wss://a-long-agentvoice-server-name.private-tailnet.example:48415/v2/client",
                            ServerProfileState.READY)), selectedProfileId = "one", onForgetProfile = {})
                }
            }
        }
        capture("landscape-large-text")
        compose.onNodeWithTag("connection-connect").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("connection-scan").performScrollTo().assertIsDisplayed()
        capture("landscape-large-text-actions")
    }

    private fun capture(name: String) {
        compose.mainClock.advanceTimeByFrame()
        compose.waitForIdle()
        val output = File("build/reports/connection-renders").apply { mkdirs() }
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            File(output, "$name.png").outputStream().use {
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
            }
            bitmap.recycle()
        }
    }

    private val fixtures = listOf(
        ServerProfile("one", "Server 1", "wss://agentvoice.example:48414/v2/client", ServerProfileState.READY),
        ServerProfile("two", "Server 2", "wss://agentvoice.example:48415/v2/client", ServerProfileState.READY),
    )
}
