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

    private fun legacyProfile(profile: String, version: Int) = JSONObject(profile).withoutTraceJoinFields().put("version", version).apply {
        remove("landscape"); remove("personaSide")
        getJSONObject("design").remove("spacing")
    }

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
            val design = PreviewDesign(controlsHeightDp = 380, holdSharePercent = 54.3, traces = PreviewTraces("circuit", 135, 180, 41, 65, 185))
            val halo = PreviewHalo(variant = "contained", containedSizePercent = 82, ringSpreadPercent = 45,
                listeningPulsePercent = 15, speakingMotionPercent = 80, idleBreathingPercent = 0,
                speakingColor = "#ff82dd", listeningColor = "#44efbb", idleColor = "#eeedcc")
            savePersonaTuning(fixture, encodePersonaTuning(tuned, design, halo))
            val restored = decodePersonaTuning(fixture.readText())
            assertEquals(.78f, restored.speakingScale)
            assertEquals(.52f, restored.listeningScale)
            assertEquals(.78f, restored.idleScale)
            assertEquals((-24).dp, restored.offsetY)
            assertEquals(20, JSONObject(fixture.readText()).getInt("version"))
            assertEquals(PreviewSpirit(), decodePersonaSpirit(fixture.readText()))
            assertEquals(PreviewSpirit(), decodePersonaSpirit(legacy))
            assertEquals(halo, decodePersonaHalo(fixture.readText()))
            assertEquals(PreviewHalo(), decodePersonaHalo(legacy))
            assertEquals(design, decodePersonaDesign(fixture.readText()))
            assertEquals(PreviewDesign(), decodePersonaDesign(legacy))
            val v9 = legacyProfile(encodePersonaTuning(tuned, design, halo, PreviewSpirit("soft", 72, "follow")), 9).apply {
                getJSONObject("design").getJSONObject("traces").apply {
                    remove("personaSpacingPercent"); remove("footSpacingPercent")
                }
            }.toString()
            fixture.writeText(v9)
            assertEquals(design.copy(traces = design.traces.copy(personaSpacingPercent = 100, footSpacingPercent = 100)), decodePersonaDesign(fixture.readText()))
            assertEquals(tuned, decodePersonaTuning(v9))
            assertEquals(halo, decodePersonaHalo(v9))
            assertEquals(PreviewSpirit("soft", 72, "follow"), decodePersonaSpirit(v9))
            assertEquals(v9, fixture.readText())
            assertThrows(IllegalArgumentException::class.java) { decodePersonaDesign(JSONObject(v9).put("version", 10).toString()) }
            assertThrows(IllegalArgumentException::class.java) {
                decodePersonaDesign(legacyProfile(encodePersonaTuning(tuned, design, halo), 9).toString())
            }
            val v3 = legacyProfile(encodePersonaTuning(tuned, design), 3)
                .put("design", JSONObject().put("layout", "studio").put("header", "drawer")
                    .put("mute", "rockers").put("hold", "trigger")).toString()
            fixture.writeText(v3)
            assertEquals(PreviewDesign(), decodePersonaDesign(fixture.readText()))
            assertEquals(tuned, decodePersonaTuning(fixture.readText()))
            assertEquals(v3, fixture.readText())
            assertEquals(PreviewHalo(), decodePersonaHalo(v3))
            val previous = design.copy(traces = PreviewTraces())
            val oldDesign = previous.json().withoutIndependentExtents().apply { remove("composition"); remove("traces"); remove("spacing"); put("hold", "trigger"); put("mute", "keycaps") }
            val v4 = legacyProfile(encodePersonaTuning(tuned, previous), 4).apply {
                remove("halo"); put("design", oldDesign)
            }.toString()
            assertEquals(PreviewHalo(), decodePersonaHalo(v4))
            assertEquals(previous, decodePersonaDesign(v4))
            val v5 = JSONObject(v4).put("version", 5).put("halo", halo.json()).toString()
            assertEquals(previous, decodePersonaDesign(v5))
            assertEquals(halo, decodePersonaHalo(v5))
            val v6 = legacyProfile(encodePersonaTuning(tuned, design, halo), 6).apply { remove("spirit"); getJSONObject("design").apply { remove("traces"); put("composition", "dock") } }.toString()
            assertEquals(PreviewSpirit(), decodePersonaSpirit(v6))
            assertEquals(previous, decodePersonaDesign(v6))
            assertEquals(halo, decodePersonaHalo(v6))
            val futureBody = JSONObject(v6).apply { getJSONObject("design").put("composition", "socket") }.toString()
            assertThrows(IllegalArgumentException::class.java) { decodePersonaDesign(futureBody) }
            assertEquals("traces", decodePersonaDesign(JSONObject(futureBody).put("version", 7).toString()).composition)
            for (invalidSpirit in listOf(PreviewSpirit().json().put("strengthPercent", 101),
                PreviewSpirit().json().put("strengthPercent", 1.5), PreviewSpirit().json().put("extra", true))) {
                assertThrows(IllegalArgumentException::class.java) { decodePreviewSpirit(invalidSpirit) }
            }
            for (version in listOf(6, 7, 8)) {
                val bodies = if (version == 6) listOf("open", "dock", "yoke") else listOf("open", "dock", "yoke", "socket", "traces")
                for (body in bodies) {
                    val older = legacyProfile(encodePersonaTuning(tuned, design, halo, PreviewSpirit("soft", 72, "follow")), version).apply {
                        if (version == 6) remove("spirit")
                        getJSONObject("design").apply {
                            remove("traces"); put("composition", body)
                            if (version < 8) { put("mute", "keycaps"); put("hold", "trigger") }
                        }
                    }.toString()
                    fixture.writeText(older)
                    assertEquals(previous, decodePersonaDesign(fixture.readText()))
                    assertEquals(tuned, decodePersonaTuning(fixture.readText()))
                    assertEquals(halo, decodePersonaHalo(fixture.readText()))
                    assertEquals(if (version >= 7) PreviewSpirit("soft", 72, "follow") else PreviewSpirit(), decodePersonaSpirit(fixture.readText()))
                    assertEquals(older, fixture.readText())
                    assertThrows(IllegalArgumentException::class.java) { decodePersonaDesign(JSONObject(older).put("version", if (version < 8) 8 else 9).toString()) }
                }
            }
            for ((field, bad) in listOf("pattern" to "socket", "stancePercent" to 74, "stancePercent" to 151,
                "weightPercent" to 49, "weightPercent" to 251, "offshootPercent" to -1, "offshootPercent" to 101,
                "glowPercent" to 101, "glowPercent" to 0.5, "extra" to true)) {
                assertThrows(IllegalArgumentException::class.java) { decodePreviewTraces(PreviewTraces().json().put(field, bad)) }
            }
            for (field in listOf("personaSpacingPercent", "footSpacingPercent")) {
                for (bad in listOf(49, 201, 100.5, "100", JSONObject.NULL)) {
                    assertThrows(IllegalArgumentException::class.java) { decodePreviewTraces(PreviewTraces().json().put(field, bad)) }
                }
                assertThrows(IllegalArgumentException::class.java) { decodePreviewTraces(PreviewTraces().json().apply { remove(field) }) }
                for (value in listOf(50, 100, 200)) assertEquals(value, decodePreviewTraces(PreviewTraces().json().put(field, value)).json().getInt(field))
            }
            assertThrows(IllegalArgumentException::class.java) { decodePreviewDesign(design.json().put("composition", "socket")) }
            for (old in listOf(v4, v5)) {
                val invalid = JSONObject(old).apply { getJSONObject("design").put("hold", "rocker") }.toString()
                assertThrows(IllegalArgumentException::class.java) { decodePersonaDesign(invalid) }
            }
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
                val request = JSONObject().put("id", 1).put("method", "preview").put("orientation", "portrait").put("orientationEpoch", 0).put("personaSide", "left").put("activity", "voice").put("spirit", PreviewSpirit("soft", 42, "follow").json()).put("connection", "connected").put("mode", "listening")
                    .put("theme", "bright").put("mutedPresence", "tide").put("mutedTuning", PreviewMutedTuning().json()).put("presenceScope", "any-muted").put("horizontalOffsetDp", 0).put("appearanceOverrides", emptySet<String>().appearanceJson()).put("sounds", PreviewSounds().json()).put("showPushToTalk", true).put("icons", PreviewIcons().json()).put("launcher", "current")
                    .put("scales", JSONObject().put("speaking", 78).put("listening", 52).put("idle", 78))
                    .put("verticalOffsetDp", -24)
                    .put("design", PreviewDesign(controlsHeightDp = 380, holdSharePercent = 54.3, traces = PreviewTraces("circuit", 135, 180, 41, 65, 185)).json())
                    .put("halo", PreviewHalo(variant = "contained", containedSizePercent = 82, speakingColor = "#ff82dd").json())
                writer.write((request.toString() + "\n").toByteArray())
                val response = JSONObject(readFrame(socket.inputStream, 16384)!!)
                assertEquals(1, response.getInt("id"))
                assertEquals(52, response.getJSONObject("state").getJSONObject("scales").getInt("listening"))
                assertEquals(-24, response.getJSONObject("state").getInt("verticalOffsetDp"))
                writer.write((request.put("id", 2).put("scales", JSONObject().put("speaking", 78).put("listening", 999).put("idle", 78)).toString() + "\n").toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream, 16384)!!).has("error"))
                assertFalse(fixture.exists())
                writer.write((request.put("id", 5).put("scales", JSONObject().put("speaking", 78).put("listening", 52).put("idle", 78))
                    .put("verticalOffsetDp", 201).toString() + "\n").toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream, 16384)!!).has("error"))
                writer.write("{\"id\":3,\"method\":\"save\",\"orientation\":\"portrait\",\"orientationEpoch\":0,\"revision\":0}\n".toByteArray())
                assertTrue(JSONObject(readFrame(socket.inputStream, 16384)!!).has("error"))
                assertFalse(fixture.exists())
                writer.write("{\"id\":4,\"method\":\"save\",\"orientation\":\"portrait\",\"orientationEpoch\":0,\"revision\":1}\n".toByteArray())
                val saved = JSONObject(readFrame(socket.inputStream, 16384)!!)
                assertEquals(fixture.readText(), saved.getString("profile"))
                assertEquals(.52f, decodePersonaTuning(fixture.readText()).listeningScale)
                assertEquals((-24).dp, decodePersonaTuning(fixture.readText()).offsetY)
                assertEquals(82, decodePersonaHalo(fixture.readText()).containedSizePercent)
                assertEquals("#ff82dd", decodePersonaHalo(fixture.readText()).speakingColor)
                assertEquals(380, decodePersonaDesign(fixture.readText()).controlsHeightDp)
                assertEquals("rocker", decodePersonaDesign(fixture.readText()).hold)
                assertEquals("traces", decodePersonaDesign(fixture.readText()).composition)
                assertEquals(PreviewTraces("circuit", 135, 180, 41, 65, 185), decodePersonaDesign(fixture.readText()).traces)
                assertEquals(PreviewSpirit("soft", 42, "follow"), decodePersonaSpirit(fixture.readText()))
                assertFalse(JSONObject(fixture.readText()).has("activity"))
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
                val returned = JSONObject(readFrame(socket.inputStream, 16384)!!).getJSONObject("state")
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
