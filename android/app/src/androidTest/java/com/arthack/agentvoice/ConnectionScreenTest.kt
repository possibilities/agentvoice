package com.arthack.agentvoice

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
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

        compose.onNodeWithText("Make a\nconnection.").assertIsDisplayed()
        compose.onNodeWithText("Your agent").assertIsDisplayed()
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

        compose.onNodeWithText("Your connection.").assertIsDisplayed()
        compose.onNodeWithText("Finish pairing this phone with your agent.").assertIsDisplayed()
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
