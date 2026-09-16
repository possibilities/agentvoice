package com.arthack.agentvoice

import android.os.Looper
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Exercise the real controller's presentation evidence with fake transport and media. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CallPresentationLifecycleTest {
    @Test fun reachingLiveSurvivesPeerLossAndResetsOnlyForANewAttempt() {
        lateinit var transport: FakeTransport
        lateinit var peer: PeerEvents
        val controller = CallController(RuntimeEnvironment.getApplication(),
            mediaFactory = { events -> peer = events; FakeMedia() },
            transportFactory = { _, events -> FakeTransport(events).also { transport = it } },
            permissionGranted = { true }, observeNetwork = false)
        val credential = DeviceGrant.parse("""{"version":1,"endpoint":"wss://example.test/v2/client","token":"${"a".repeat(32)}.${"b".repeat(64)}"}""")
        fun flush() { shadowOf(Looper.getMainLooper()).idle() }
        fun receive(value: String) { transport.events.text(value) {}; flush() }
        val session = "11111111-1111-4111-8111-111111111111"
        try {
            controller.start(credential)
            assertFalse(controller.ui.hasReachedLive)
            transport.events.opened(); flush()
            val id = transport.requests.first().string("id")
            receive("""{"v":3,"type":"response","id":"$id","ok":true,"result":null}""")
            receive("""{"v":3,"type":"client-media","message":{"type":"prepare","sessionId":"$session"}}""")
            peer.connected(session)
            assertFalse(controller.ui.hasReachedLive)
            receive("""{"v":3,"type":"state","state":{"codingActivity":"unknown","available":true,"phase":"live","mic":{"muted":true,"effectiveMuted":true},"speaker":{"muted":true,"effectiveMuted":true}}}""")
            assertTrue(controller.ui.connected)
            assertTrue(controller.ui.hasReachedLive)
            peer.disconnected(session)
            assertFalse(controller.ui.connected)
            assertTrue(controller.ui.hasReachedLive)
            // A newly bound Activity derives this from the retained controller, not local memory.
            assertEquals(VoicePresentation.Disconnected, voicePresentation(controller.ui, VoicePreparation.Loading))
            controller.stop("Call ended.")
            controller.start(credential)
            assertFalse(controller.ui.hasReachedLive)
            assertEquals(VoicePresentation.Connecting, voicePresentation(controller.ui))
        } finally { controller.dispose() }
    }

    private class FakeTransport(val events: TransportEvents) : CallTransport {
        val requests = mutableListOf<JsonObject>()
        override fun send(value: String): Boolean { requests += jsonObject(value); return true }
        override fun cancel() = Unit
    }
    private class FakeMedia : MediaEngine {
        override val inputLevel = 0f
        override val outputLevel = 0f
        override fun prepare(id: String) = Unit
        override fun answer(id: String, sdp: String) = Unit
        override fun isActive(id: String) = true
        override fun hasConnectedPeer() = true
        override fun gates(mic: Boolean, speaker: Boolean) = Unit
        override fun close(id: String) = Unit
        override fun stop() = Unit
    }
}
