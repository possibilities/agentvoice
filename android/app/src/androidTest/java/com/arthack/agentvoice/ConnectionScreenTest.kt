package com.arthack.agentvoice

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.platform.app.InstrumentationRegistry
import android.graphics.Bitmap
import java.io.File
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ConnectionScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun unpairedRootOffersOnlyTheScannerAction() {
        val actions = mutableListOf<String>()
        screen(CallUi(), paired = false, actions = actions)

        compose.onNodeWithText("Connections").assertIsDisplayed()
        compose.onNodeWithTag("connection-scan").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithTag("connection-connect").assertDoesNotExist()
        compose.onNodeWithTag("connection-disconnect").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("scan"), actions) }
    }

    @Test fun idleFailureAndConnectingExposeOneMeaningfulActionEach() {
        var ui by mutableStateOf(CallUi())
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(ui, true, { actions += "connect" }, { actions += "return" },
                    { actions += "disconnect" }, { actions += "scan" })
            }
        }

        compose.onNodeWithTag("connection-connect").assertTextEquals("Connect").performClick()
        compose.runOnIdle { ui = CallUi(message = "private diagnostic must not be rendered") }
        compose.onNodeWithTag("connection-connect").assertTextEquals("Try again").performClick()
        compose.onNodeWithText("private diagnostic must not be rendered").assertDoesNotExist()
        compose.runOnIdle { ui = CallUi(running = true, phase = "Connecting") }
        compose.onNodeWithTag("connection-cancel").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithTag("connection-connect").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("connect", "connect", "disconnect"), actions) }
    }

    @Test fun pendingPairingOffersAnExplicitFinishAction() {
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(CallUi(), paired = false, onConnect = {}, onReturnToCall = {},
                    onDisconnect = {}, onScan = { actions += "scan" }, pairingPending = true)
            }
        }

        compose.onNodeWithText("Connections").assertIsDisplayed()
        compose.onNodeWithTag("connection-status").assertTextEquals("Pairing not finished")
        compose.onNodeWithTag("connection-finish-pairing").assertTextEquals("Finish pairing").performClick()
        compose.onNodeWithTag("connection-scan").assertDoesNotExist()
        compose.onNodeWithText("Scan to connect").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("scan"), actions) }
    }

    @Test fun activeCallSeparatesReturnFromExplicitDisconnect() {
        val actions = mutableListOf<String>()
        screen(CallUi(running = true, connected = true, phase = "Connected"), actions = actions)

        compose.onNodeWithTag("connection-status").assertTextEquals("Call in progress")
        compose.onNodeWithTag("connection-return").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals(listOf("return"), actions) }
        compose.onNodeWithTag("connection-disconnect").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals(listOf("return", "disconnect"), actions) }
    }

    @Test fun normalCallEndReturnsToTheDisconnectedConnectState() {
        val actions = mutableListOf<String>()
        screen(CallUi(message = "Call ended normally."), actions = actions)

        compose.onNodeWithTag("connection-status").assertTextEquals("Ready to connect")
        compose.onNodeWithTag("connection-connect").assertTextEquals("Connect").performClick()
        compose.onNodeWithText("Couldn’t connect").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("connect"), actions) }
    }

    @Test fun unavailableAndStoppedAttemptsRequireAnExplicitEnd() {
        var ui by mutableStateOf(CallUi(running = true, phase = "Voice unavailable"))
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(ui, true, {}, {}, { actions += "disconnect" }, {})
            }
        }

        compose.onNodeWithTag("connection-status").assertTextEquals("Voice unavailable")
        compose.onNodeWithTag("connection-end-attempt").assertTextEquals("End attempt").performClick()
        compose.onNodeWithTag("connection-cancel").assertDoesNotExist()
        compose.runOnIdle { ui = CallUi(running = true, phase = "Voice stopped") }
        compose.onNodeWithTag("connection-status").assertTextEquals("Voice stopped")
        compose.onNodeWithTag("connection-end-attempt").assertTextEquals("End attempt").performClick()
        compose.onNodeWithTag("connection-connect").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("disconnect", "disconnect"), actions) }
    }

    @Test fun largeTextKeepsPrimaryActionsReachableAndCreditsOptional() {
        val actions = mutableListOf<String>()
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.5f)) {
                VoiceTheme {
                    ConnectionScreen(CallUi(), true, { actions += "connect" }, {}, {}, {},
                        onCredits = { actions += "credits" })
                }
            }
        }

        compose.onNodeWithTag("connection-screen").assertIsDisplayed()
        compose.onNodeWithTag("connection-connect").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithTag("connection-credits").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals(listOf("connect", "credits"), actions) }
    }

    @Test fun multipleServersKeepCurrentCallAndTargetActionsDistinct() {
        val actions = mutableListOf<String>()
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(CallUi(running = true, connected = true), true, {},
                    { actions += "return" }, { actions += "disconnect" }, { actions += "scan" },
                    profiles = fixtureProfiles, attemptedProfileId = "one", selectedProfileId = "one",
                    onConnectProfile = { actions += "connect:$it" }, onForgetProfile = { actions += "forget:$it" })
            }
        }
        compose.onNodeWithText("Server 1").assertIsDisplayed()
        compose.onNodeWithText("Server 2").assertIsDisplayed()
        compose.onNodeWithTag("connection-return").performClick()
        compose.onNodeWithTag("connection-connect-two").performScrollTo().performClick()
        compose.onNodeWithTag("connection-menu-two").performScrollTo().performClick()
        compose.onNodeWithText("Forget server").performClick()
        compose.runOnIdle { assertEquals(listOf("return", "connect:two", "forget:two"), actions) }
    }

    @Test fun switchingDisablesConnectionActionsAndRendersEverySavedState() {
        var saved by mutableStateOf(emptyList<ServerProfile>())
        var ui by mutableStateOf(CallUi())
        var busy by mutableStateOf<String?>(null)
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(ui, saved.isNotEmpty(), {}, {}, {}, {}, profiles = saved,
                    selectedProfileId = "one", attemptedProfileId = "one", busyProfileId = busy,
                    onConnectProfile = {}, onForgetProfile = {})
            }
        }
        capture("empty")
        compose.runOnIdle { saved = fixtureProfiles.take(1) }
        capture("single")
        compose.runOnIdle { saved = fixtureProfiles }
        capture("multiple")
        compose.runOnIdle { ui = CallUi(running = true, connected = true) }
        capture("current")
        compose.runOnIdle { ui = CallUi(message = "Private diagnostic") }
        capture("error")
        compose.runOnIdle { busy = "two" }
        compose.onNodeWithText("Switching…").assertIsDisplayed()
        compose.onNodeWithTag("connection-connect").assertIsNotEnabled()
        compose.onNodeWithTag("connection-connect-two").assertIsNotEnabled()
        compose.onNodeWithTag("connection-menu-one").assertIsNotEnabled()
        capture("switching")
    }

    private val fixtureProfiles = listOf(
        ServerProfile("one", "Server 1", "wss://agentvoice.example:48414/v2/client", ServerProfileState.READY),
        ServerProfile("two", "Server 2", "wss://agentvoice.example:48415/v2/client", ServerProfileState.READY),
    )

    private fun capture(name: String) {
        compose.waitForIdle()
        val directory = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,
            "connection-renders").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            check(compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }

    private fun screen(
        ui: CallUi,
        paired: Boolean = true,
        actions: MutableList<String>,
    ) {
        compose.setContent {
            VoiceTheme {
                ConnectionScreen(ui, paired, { actions += "connect" }, { actions += "return" },
                    { actions += "disconnect" }, { actions += "scan" })
            }
        }
    }
}
