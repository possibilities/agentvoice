package com.arthack.agentvoice

import android.net.LocalSocket
import android.net.LocalSocketAddress
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class PersonaPreviewTest {
    @get:Rule val compose = createComposeRule()

    @Test fun profileMigrationAndAtomicSaveKeepAllThreeSizes() {
        val legacy = """{"version":1,"scaleMultiplier":0.78,"verticalOffsetDp":35}"""
        val initial = decodePersonaTuning(legacy)
        val directory = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        val fixture = File(directory, "persona-test-${UUID.randomUUID()}.json")
        try {
            fixture.writeText(legacy)
            assertEquals(.78f, initial.listeningScale)
            assertEquals(legacy, fixture.readText())
            val tuned = initial.copy(listeningScale = .52f)
            savePersonaTuning(fixture, encodePersonaTuning(tuned))
            val restored = decodePersonaTuning(fixture.readText())
            assertEquals(.78f, restored.speakingScale)
            assertEquals(.52f, restored.listeningScale)
            assertEquals(.78f, restored.idleScale)
            assertEquals(35.dp, restored.offsetY)
            assertEquals(2, JSONObject(fixture.readText()).getInt("version"))
        } finally { fixture.delete() }
    }

    @Test fun nativePreviewHasNoTuningOverlayAndStillRespondsToPhoneControls() {
        var state by mutableStateOf(PersonaPreviewState())
        compose.setContent { VoiceTheme { PersonaPreview(state) { state = it } } }
        compose.onNodeWithText("Save").assertDoesNotExist()
        compose.onNodeWithText("Adjust Halo").assertDoesNotExist()
        compose.onNodeWithTag("mic-mute").performClick()
        compose.runOnIdle { assertEquals("listening", state.mode) }
        compose.onNodeWithTag("speaker-mute").performClick()
        compose.runOnIdle { assertEquals("speaking", state.mode) }
        compose.onNodeWithTag("end-call").performClick()
        compose.runOnIdle { assertEquals("idle", state.mode) }
    }

    @Test fun adbPreviewBridgeAuthenticatesBoundsFramesAndReleasesItsSocket() {
        val name = "agentvoice-halo-test-${UUID.randomUUID()}"
        val token = "a".repeat(64)
        val commands = AtomicInteger(0)
        val directory = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        val fixture = File(directory, "persona-bridge-test-${UUID.randomUUID()}.json")
        val session = PersonaPreviewSession(PersonaPlacement(), fixture)
        val bridge = PersonaPreviewBridge(name, token) { request ->
            commands.incrementAndGet()
            session.command(request)
        }
        fun connect() = LocalSocket().apply {
            connect(LocalSocketAddress(name))
            soTimeout = 2500
        }
        try {
            connect().use { socket ->
                socket.outputStream.write("{\"token\":\"wrong\"}\n".toByteArray())
                assertEquals(-1, socket.inputStream.read())
            }
            assertEquals(0, commands.get())
            connect().use { socket ->
                val writer = socket.outputStream
                writer.write((JSONObject().put("token", token).toString() + "\n").toByteArray())
                val request = JSONObject().put("id", 1).put("method", "preview").put("mode", "listening")
                    .put("scales", JSONObject().put("speaking", 78).put("listening", 52).put("idle", 78))
                writer.write((request.toString() + "\n").toByteArray())
                val response = JSONObject(readFrame(socket.inputStream)!!)
                assertEquals(1, response.getInt("id"))
                assertEquals(52, response.getJSONObject("state").getJSONObject("scales").getInt("listening"))
                writer.write((request.put("id", 2).put("scales", JSONObject().put("speaking", 78).put("listening", 999).put("idle", 78)).toString() + "\n").toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream)!!).has("error"))
                assertFalse(fixture.exists())
                writer.write("{\"id\":3,\"method\":\"save\",\"revision\":0}\n".toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream)!!).has("error"))
                assertFalse(fixture.exists())
                writer.write("{\"id\":4,\"method\":\"save\",\"revision\":1}\n".toByteArray())
                val saved = JSONObject(readFrame(socket.inputStream)!!)
                assertEquals(fixture.readText(), saved.getString("profile"))
                assertEquals(.52f, decodePersonaTuning(fixture.readText()).listeningScale)
            }
            connect().use { socket ->
                socket.outputStream.write("{\"token\":\"wrong\"}\n".toByteArray())
                assertEquals(-1, socket.inputStream.read())
            }
            assertEquals(4, commands.get())
            connect().use { socket ->
                socket.outputStream.write((JSONObject().put("token", token).toString() + "\n").toByteArray())
                socket.outputStream.write("{\"id\":1,\"method\":\"get\"}\n".toByteArray())
                val returned = JSONObject(readFrame(socket.inputStream)!!).getJSONObject("state")
                assertEquals(1, returned.getInt("revision"))
                assertEquals(52, returned.getJSONObject("scales").getInt("listening"))
                bridge.close()
                assertEquals(-1, socket.inputStream.read())
            }
            assertThrows(IllegalStateException::class.java) {
                readFrame(ByteArrayInputStream("x".repeat(8192).toByteArray()))
            }
        } finally { bridge.close(); fixture.delete() }
    }
}
