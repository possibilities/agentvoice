package com.arthack.agentvoice

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** Fake transports/media exercise the actual Android controller without credentials or devices. */
class CallControllerTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var controller: CallController
    private lateinit var transport: FakeTransport
    private lateinit var media: FakeMedia
    private val session = "11111111-1111-4111-8111-111111111111"
    private val successor = "22222222-2222-4222-8222-222222222222"
    private val grant = DeviceGrant.parse("""{"version":1,"endpoint":"wss://example.test/v2/client","token":"${"a".repeat(32)}.${"b".repeat(64)}"}""")
    private fun main(block: () -> Unit) { instrumentation.runOnMainSync(block); instrumentation.waitForIdleSync() }
    private class FakeTransport(val events: TransportEvents) : CallTransport {
        val requests = mutableListOf<JsonObject>()
        var cancelled = false
        override fun send(value: String): Boolean { requests.add(jsonObject(value)); return !cancelled }
        override fun cancel() { cancelled = true }
    }
    private class FakeMedia(val events: PeerEvents) : MediaEngine {
        override val inputLevel = 0f
        override val outputLevel = 0f
        var mic = false
        var speaker = false
        var stopped = false
        var live: String? = null
        val prepared = mutableSetOf<String>()
        override fun prepare(id: String) { prepared.add(id) }
        override fun answer(id: String, sdp: String) = Unit
        override fun isActive(id: String) = live == id
        override fun hasConnectedPeer() = live != null
        override fun gates(mic: Boolean, speaker: Boolean) { this.mic = mic; this.speaker = speaker }
        override fun close(id: String) { prepared.remove(id); if (live == id) live = null }
        override fun stop() { stopped = true; mic = false; speaker = false; live = null; prepared.clear() }
        fun connect(id: String) { live = id; events.connected(id) }
    }
    private fun start() {
        main {
            controller = CallController(instrumentation.targetContext,
                mediaFactory = { events -> FakeMedia(events).also { media = it } },
                transportFactory = { _, events -> FakeTransport(events).also { transport = it } },
                permissionGranted = { true }, observeNetwork = false)
            controller.start(grant)
            transport.events.opened()
        }
        reply(transport.requests.first().string("id"))
        receive("""{"v":2,"type":"client-media","message":{"type":"prepare","sessionId":"$session"}}""")
        main { media.connect(session) }
        state(true, true)
    }
    private fun receive(value: String) { main { transport.events.text(value) {} } }
    private fun reply(id: String) = receive("""{"v":2,"type":"response","id":"$id","ok":true,"result":null}""")
    private fun state(muted: Boolean, effective: Boolean, phase: String = "live") = receive("""{"v":2,"type":"state","state":{"available":true,"phase":"$phase","mic":{"muted":$muted,"effectiveMuted":$effective},"speaker":{"muted":false,"effectiveMuted":false}}}""")

    @After fun cleanup() { if (::controller.isInitialized) main { controller.dispose() } }

    @Test fun releasedHoldNeverReopensFromItsLateReplyOrState() {
        start()
        main { assertTrue(controller.ui.connected); controller.hold() }
        val hold = transport.requests.last().string("id")
        main { controller.release(); assertFalse(media.mic) }
        state(true, false)
        reply(hold)
        main { assertFalse(media.mic); assertFalse(controller.ui.holding) }
    }
    @Test fun oldHoldReplyCannotAcknowledgeANewPress() {
        start()
        main { controller.hold() }
        val oldHold = transport.requests.last().string("id")
        main { controller.release(); controller.hold() }
        val newHold = transport.requests.last().string("id")
        state(true, false)
        reply(oldHold)
        main { assertFalse(media.mic) }
        reply(newHold)
        main { assertTrue(media.mic); controller.release(); assertFalse(media.mic) }
    }
    @Test fun runtimeStopAndStaleSessionClosePreserveTheOwnerAndSuccessor() {
        start()
        state(true, true, "stopped")
        main { assertTrue(controller.ui.running); assertFalse(transport.cancelled); assertFalse(media.mic) }
        receive("""{"v":2,"type":"client-media","message":{"type":"prepare","sessionId":"$successor"}}""")
        main { media.connect(successor) }
        state(true, true)
        receive("""{"v":2,"type":"client-media","message":{"type":"close","sessionId":"$session"}}""")
        main { assertTrue(controller.ui.connected); assertEquals(successor, media.live); assertFalse(transport.cancelled) }
    }
    @Test fun transportLossImmediatelyClosesMediaAndOldCallbacksCannotRestartIt() {
        start()
        val oldMedia = media
        val oldTransport = transport
        main { transport.events.ended("Connection ended") }
        main {
            assertTrue(oldMedia.stopped); assertTrue(oldTransport.cancelled)
            assertFalse(controller.ui.running)
            oldMedia.events.connected(session)
            oldTransport.events.opened()
        }
        main { assertFalse(controller.ui.running); assertFalse(oldMedia.mic) }
    }
    @Test fun unsolicitedResponseIsTerminal() {
        start()
        reply("unknown")
        main { assertTrue(media.stopped); assertTrue(transport.cancelled); assertFalse(controller.ui.running) }
    }
}
