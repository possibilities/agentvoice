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
            assertEquals(35.dp, initial.offsetY)
            val tuned = initial.copy(listeningScale = .52f, offsetY = (-24).dp)
            val design = PreviewDesign(mute = "rockers", controlsHeightDp = 380, holdSharePercent = 54.3)
            savePersonaTuning(fixture, encodePersonaTuning(tuned, design))
            val restored = decodePersonaTuning(fixture.readText())
            assertEquals(.78f, restored.speakingScale)
            assertEquals(.52f, restored.listeningScale)
            assertEquals(.78f, restored.idleScale)
            assertEquals((-24).dp, restored.offsetY)
            assertEquals(4, JSONObject(fixture.readText()).getInt("version"))
            assertEquals(design, decodePersonaDesign(fixture.readText()))
            assertEquals(PreviewDesign(), decodePersonaDesign(legacy))
            val v3 = JSONObject(encodePersonaTuning(tuned, design)).put("version", 3)
                .put("design", JSONObject().put("layout", "studio").put("header", "drawer")
                    .put("mute", "rockers").put("hold", "trigger")).toString()
            fixture.writeText(v3)
            assertEquals(PreviewDesign(mute = "rockers"), decodePersonaDesign(fixture.readText()))
            assertEquals(tuned, decodePersonaTuning(fixture.readText()))
            assertEquals(v3, fixture.readText())
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
        compose.runOnIdle { assertTrue(state.speakerMuted); assertEquals("listening", state.mode) }
        compose.onNodeWithTag("speaker-mute").performClick()
        compose.runOnIdle { assertEquals("speaking", state.mode) }
        compose.onNodeWithTag("preview-header").assertDoesNotExist()
        compose.onNodeWithContentDescription("Push to talk").assertExists()
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
                val request = JSONObject().put("id", 1).put("method", "preview").put("connection", "connected").put("mode", "listening")
                    .put("scales", JSONObject().put("speaking", 78).put("listening", 52).put("idle", 78))
                    .put("verticalOffsetDp", -24)
                    .put("design", PreviewDesign(mute = "rockers", controlsHeightDp = 380, holdSharePercent = 54.3).json())
                writer.write((request.toString() + "\n").toByteArray())
                val response = JSONObject(readFrame(socket.inputStream)!!)
                assertEquals(1, response.getInt("id"))
                assertEquals(52, response.getJSONObject("state").getJSONObject("scales").getInt("listening"))
                assertEquals(-24, response.getJSONObject("state").getInt("verticalOffsetDp"))
                writer.write((request.put("id", 2).put("scales", JSONObject().put("speaking", 78).put("listening", 999).put("idle", 78)).toString() + "\n").toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream)!!).has("error"))
                assertFalse(fixture.exists())
                writer.write((request.put("id", 5).put("scales", JSONObject().put("speaking", 78).put("listening", 52).put("idle", 78))
                    .put("verticalOffsetDp", 201).toString() + "\n").toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream)!!).has("error"))
                writer.write("{\"id\":3,\"method\":\"save\",\"revision\":0}\n".toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream)!!).has("error"))
                assertFalse(fixture.exists())
                writer.write("{\"id\":4,\"method\":\"save\",\"revision\":1}\n".toByteArray())
                val saved = JSONObject(readFrame(socket.inputStream)!!)
                assertEquals(fixture.readText(), saved.getString("profile"))
                assertEquals(.52f, decodePersonaTuning(fixture.readText()).listeningScale)
                assertEquals((-24).dp, decodePersonaTuning(fixture.readText()).offsetY)
                assertEquals(380, decodePersonaDesign(fixture.readText()).controlsHeightDp)
                assertEquals(54.3, decodePersonaDesign(fixture.readText()).holdSharePercent, 0.00001)
            }
            connect().use { socket ->
                socket.outputStream.write("{\"token\":\"wrong\"}\n".toByteArray())
                assertEquals(-1, socket.inputStream.read())
            }
            assertEquals(5, commands.get())
            connect().use { socket ->
                socket.outputStream.write((JSONObject().put("token", token).toString() + "\n").toByteArray())
                socket.outputStream.write("{\"id\":1,\"method\":\"get\"}\n".toByteArray())
                val returned = JSONObject(readFrame(socket.inputStream)!!).getJSONObject("state")
                assertEquals(1, returned.getInt("revision"))
                assertEquals(52, returned.getJSONObject("scales").getInt("listening"))
                assertEquals(-24, returned.getInt("verticalOffsetDp"))
                bridge.close()
                assertEquals(-1, socket.inputStream.read())
            }
            assertThrows(IllegalStateException::class.java) {
                readFrame(ByteArrayInputStream("x".repeat(8192).toByteArray()))
            }
        } finally { bridge.close(); fixture.delete() }
    }
}
