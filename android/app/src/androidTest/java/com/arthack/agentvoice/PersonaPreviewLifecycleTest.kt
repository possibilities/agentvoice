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
                val preview = JSONObject().put("id", 1).put("method", "preview").put("connection", "connecting").put("mode", "listening")
                    .put("scales", JSONObject().put("speaking", 69).put("listening", 49).put("idle", 72))
                    .put("verticalOffsetDp", -24)
                    .put("design", PreviewDesign(mute = "rockers", hold = "rocker", composition = "yoke", controlsHeightDp = 380, holdSharePercent = 54.3).json())
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
