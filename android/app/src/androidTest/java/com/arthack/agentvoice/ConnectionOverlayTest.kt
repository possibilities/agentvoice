package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class ConnectionOverlayTest {
    @get:Rule val compose = createComposeRule()

    @Test fun rehearsalHasAccessibleActionsAndASquareAperture() {
        var scene by mutableStateOf<ConnectionScene?>(ConnectionScene.Permission)
        compose.setContent {
            VoiceTheme { scene?.let {
                ConnectionOverlay(it, close = { scene = null }, action = { scene = ConnectionScene.Scanning }, studio = true)
            } }
        }
        compose.onNodeWithText("Scan a connection code").assertIsDisplayed()
        val aperture = compose.onNodeWithTag("connection-aperture").fetchSemanticsNode().boundsInRoot
        assertEquals(aperture.width, aperture.height, 1f)
        compose.onNodeWithText("Allow camera").performClick()
        compose.onNodeWithText("Looking for a code…").assertIsDisplayed()
        compose.onNodeWithText("Back to Studio").performClick()
        compose.onNodeWithTag("connection-overlay").assertDoesNotExist()
    }

    @Test fun everyMockSceneRendersWithoutCameraAndCloses() {
        var scene by mutableStateOf<ConnectionScene?>(ConnectionScene.Permission)
        compose.setContent { VoiceTheme { scene?.let { ConnectionOverlay(it, close = { scene = null }, studio = true) } } }
        for (next in ConnectionScene.entries) {
            compose.runOnIdle { scene = next }
            compose.onNodeWithTag("connection-title").assertTextEquals(next.title).assertIsDisplayed()
            next.action?.let {
                compose.onNodeWithTag("connection-action").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
                compose.onNodeWithText(it).assertIsDisplayed()
            }
            compose.onNodeWithTag("connection-close").performClick()
            compose.onNodeWithTag("connection-overlay").assertDoesNotExist()
        }
    }

    @Test fun rehearsalCommandsAreTransientAndRejectStaleOrientation() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "connection-rehearsal-${System.nanoTime()}.json")
        file.writeText("operator-checkpoint")
        try {
            val session = withContext(Dispatchers.Main) { PersonaPreviewSession(PersonaPlacement(), file) }
            val before = withContext(Dispatchers.Main) { session.state.designProfile() }
            var writes = 0
            session.persistWorkingDesign = { writes++ }
            val command = JSONObject().put("id", 1).put("method", "connectionPreview").put("scene", "permission")
                .put("orientation", "portrait").put("orientationEpoch", 0)
            for (scene in listOf("permission", "root-unpaired", "root-pairing-pending", "root-disconnected", "root-connecting", "root-active", "root-failed")) {
                val state = session.command(JSONObject(command.toString()).put("scene", scene)).getJSONObject("state")
                assertEquals(scene, state.getString("connectionPreview"))
                assertEquals(before, withContext(Dispatchers.Main) { session.state.designProfile() })
                assertEquals(0, writes)
                assertEquals("operator-checkpoint", file.readText())
            }
            assertEquals(before, withContext(Dispatchers.Main) { session.state.designProfile() })
            assertEquals(0, writes)
            assertEquals("operator-checkpoint", file.readText())
            assertEquals("root-failed", withContext(Dispatchers.Main) {
                restorePersonaPreview(session.state.json(), session.state.saved).connectionPreview
            })
            assertTrue(runCatching { session.command(JSONObject(command.toString()).put("orientationEpoch", 9)) }.isFailure)
            assertTrue(runCatching { session.command(JSONObject(command.toString()).put("scene", "saveGrant")) }.isFailure)
        } finally { file.delete() }
    }

    @Test fun connectionRootActionsNavigateSyntheticStateWithoutChangingDesignState() {
        var state by mutableStateOf(PersonaPreviewState(connection = "disconnected", connectionPreview = "root-active"))
        var hints = 0
        var scans = 0
        lateinit var back: androidx.activity.OnBackPressedDispatcher
        compose.setContent {
            back = androidx.activity.compose.LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            VoiceTheme {
                StudioPreviewNavigation(state, onScan = { scans++ }, showNavigationHint = { hints++ }) { state = it }
            }
        }

        compose.onNodeWithTag("connection-status").assertTextEquals("Call in progress")
        val before = state.designProfile()
        compose.onNodeWithTag("connection-return").performClick()
        compose.onNodeWithTag("connection-screen").assertDoesNotExist()
        compose.onNodeWithTag("preview-controls").assertExists()
        compose.onNodeWithTag("persona-navigation-hint").assertExists()
            .performTouchInput { longClick() }
        compose.runOnIdle {
            assertEquals(2, hints)
            assertEquals("root-active", state.connectionPreview)
            assertEquals("disconnected", state.connection)
            assertEquals(before, state.designProfile())
            assertEquals(0, scans)
            back.onBackPressed()
        }
        compose.onNodeWithTag("connection-status").assertTextEquals("Call in progress")
        compose.runOnIdle {
            assertEquals("root-active", state.connectionPreview)
            assertEquals("disconnected", state.connection)
        }
    }

    @Test fun connectionRootButtonsDriveOnlyTheTransientRehearsal() {
        var state by mutableStateOf(PersonaPreviewState(connectionPreview = "root-active"))
        var scans = 0
        compose.setContent { VoiceTheme {
            StudioPreviewNavigation(state, onScan = { scans++ }, showNavigationHint = {}) { state = it }
        } }
        val before = state.designProfile()

        compose.onNodeWithTag("connection-disconnect").performClick()
        compose.runOnIdle { assertEquals("root-disconnected", state.connectionPreview) }
        compose.onNodeWithTag("connection-connect").performClick()
        compose.runOnIdle { assertEquals("root-connecting", state.connectionPreview) }
        compose.onNodeWithTag("connection-cancel").performClick()
        compose.runOnIdle { assertEquals("root-disconnected", state.connectionPreview) }
        compose.runOnIdle { state = state.copy(connectionPreview = "root-failed") }
        compose.onNodeWithTag("connection-connect").performClick()
        compose.runOnIdle { assertEquals("root-connecting", state.connectionPreview) }
        compose.runOnIdle { state = state.copy(connectionPreview = "root-unpaired") }
        compose.onNodeWithTag("connection-scan").performClick()
        compose.runOnIdle {
            assertEquals(1, scans)
            assertEquals("scanning", state.connectionPreview)
            assertEquals(before, state.designProfile())
        }
        compose.runOnIdle { state = state.copy(connectionPreview = "root-pairing-pending") }
        compose.onNodeWithTag("connection-status").assertTextEquals("Pairing not finished")
        compose.onNodeWithTag("connection-finish-pairing").performClick()
        compose.runOnIdle {
            assertEquals(2, scans)
            assertEquals("found", state.connectionPreview)
            assertEquals(before, state.designProfile())
        }
    }
}
