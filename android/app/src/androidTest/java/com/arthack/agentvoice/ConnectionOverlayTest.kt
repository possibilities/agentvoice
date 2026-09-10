package com.arthack.agentvoice

import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
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
            next.action?.let { compose.onNodeWithTag("connection-action").assertIsDisplayed() }
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
            val state = session.command(command).getJSONObject("state")
            assertEquals("permission", state.getString("connectionPreview"))
            assertEquals(before, withContext(Dispatchers.Main) { session.state.designProfile() })
            assertEquals(0, writes)
            assertEquals("operator-checkpoint", file.readText())
            assertTrue(runCatching { session.command(JSONObject(command.toString()).put("orientationEpoch", 9)) }.isFailure)
            assertTrue(runCatching { session.command(JSONObject(command.toString()).put("scene", "saveGrant")) }.isFailure)
        } finally { file.delete() }
    }
}
