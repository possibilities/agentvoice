package com.arthack.agentvoice

import android.content.Intent
import android.net.LocalSocket
import android.net.LocalSocketAddress
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class PersonaPreviewLifecycleTest {
    @Test fun restoringOldLiveChoicesKeepsTuningAndMigratesRetiredDesigns() {
        val original = PersonaPreviewState(mode = "listening", activity = "voice", design = PreviewDesign(controlsHeightDp = 387),
            halo = PreviewHalo(variant = "contained", ringSpreadPercent = 52), spirit = PreviewSpirit("soft", 72, "follow"))
        for (protocol in listOf(7, 8)) {
            val old = original.json().put("protocol", protocol).apply {
                getJSONObject("design").apply {
                    remove("traces"); put("composition", "socket")
                    if (protocol == 7) { put("mute", "keycaps"); put("hold", "trigger") }
                }
            }
            val restored = restorePersonaPreview(old, original.saved, original.savedDesign, original.savedHalo, original.savedSpirit)
            assertEquals(original, restored)
        }
        val v9State = original.copy(design = original.design.copy(traces = PreviewTraces("splayed", 143, 190, 72, 41)))
        val v9 = v9State.json().put("protocol", 9).apply {
            getJSONObject("design").getJSONObject("traces").apply { remove("personaSpacingPercent"); remove("footSpacingPercent") }
        }
        assertEquals(v9State, restorePersonaPreview(v9, v9State.saved, v9State.savedDesign, v9State.savedHalo, v9State.savedSpirit))
    }

    @Test fun backgroundReturnAndRecreationRetainBindingAndUnsavedPreview() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "agentvoice-halo-${UUID.randomUUID().toString().replace("-", "")}"
        val token = "b".repeat(64)
        val intent = Intent(context, PersonaPreviewActivity::class.java)
            .putExtra("previewSocket", name).putExtra("previewToken", token)
        fun connect() = LocalSocket().apply {
            connect(LocalSocketAddress(name))
            soTimeout = 2500
            outputStream.write((JSONObject().put("token", token).toString() + "\n").toByteArray())
        }
        fun state(socket: LocalSocket): JSONObject {
            socket.outputStream.write("{\"id\":2,\"method\":\"get\"}\n".toByteArray())
            return JSONObject(readFrame(socket.inputStream)!!).getJSONObject("state")
        }
        ActivityScenario.launch<PersonaPreviewActivity>(intent).use { scenario ->
            var before: JSONObject
            connect().use { socket ->
                val preview = JSONObject().put("id", 1).put("method", "preview").put("orientation", "portrait").put("orientationEpoch", 0).put("personaSide", "left").put("activity", "voice").put("spirit", PreviewSpirit("soft", 42, "follow").json()).put("connection", "connecting").put("mode", "listening")
                    .put("scales", JSONObject().put("speaking", 69).put("listening", 49).put("idle", 72))
                    .put("verticalOffsetDp", -24)
                    .put("design", PreviewDesign(controlsHeightDp = 380, holdSharePercent = 54.3, traces = PreviewTraces("splayed", 140, 200, 80, 55, 75, 175)).json())
                    .put("halo", PreviewHalo(variant = "contained", containedSizePercent = 82, speakingColor = "#ff82dd").json())
                socket.outputStream.write((preview.toString() + "\n").toByteArray())
                before = JSONObject(readFrame(socket.inputStream)!!).getJSONObject("state")
                scenario.moveToState(Lifecycle.State.CREATED)
                assertEquals(-1, socket.inputStream.read())
            }
            scenario.moveToState(Lifecycle.State.RESUMED)
            scenario.onActivity { it.startActivity(Intent(it, PersonaPreviewActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            connect().use { socket -> assertEquals(before.toString(), state(socket).toString()) }
            scenario.recreate()
            connect().use { socket -> assertEquals(before.toString(), state(socket).toString()) }
        }
    }

    @Test fun restoredHoldIsReleasedAndBindingNeverPrintsItsToken() {
        val before = PersonaPreviewState(mode = "listening", holding = true, revision = 3,
            placement = PersonaPlacement(listeningScale = .49f))
        val restored = restorePersonaPreview(before.json(), PersonaPlacement())
        assertFalse(restored.holding)
        assertEquals("idle", restored.mode)
        assertEquals(.49f, restored.placement.listeningScale)
        assertEquals(.58f, restored.saved.listeningScale)
        val name = "agentvoice-halo-${"a".repeat(32)}"
        val token = "b".repeat(64)
        assertEquals("PersonaPreviewBinding(redacted)", PersonaPreviewBinding.parse(name, token).toString())
        assertNull(PersonaPreviewBinding.parse(name, "wrong"))
        assertNull(PersonaPreviewBinding.parse("other-socket", token))
    }
}
