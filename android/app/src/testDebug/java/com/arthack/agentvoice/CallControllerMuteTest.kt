package com.arthack.agentvoice

import android.os.Looper
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The controller publishes an optimistic face, but only server state opens media. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CallControllerMuteTest {
    @Test fun pushToTalkPublishesImmediatelyAndSettlementDoesNotChangeItsFace() {
        val fixture = Fixture()
        try {
            fixture.live(micMuted = true, speakerMuted = false)
            fixture.controller.hold()
            val hold = fixture.transport.requests.last()
            assertTrue(fixture.controller.ui.holding)
            assertFalse(fixture.controller.ui.micOpen)
            assertTrue(fixture.controller.ui.micMuted)
            fixture.receive(response(hold, true))
            fixture.receive(state(micMuted = true, speakerMuted = false, micEffectiveMuted = false))
            assertTrue(fixture.controller.ui.holding)
            assertTrue(fixture.controller.ui.micOpen)
            assertTrue(fixture.controller.ui.micMuted)
            fixture.controller.release()
            assertFalse(fixture.controller.ui.holding)
            assertFalse(fixture.controller.ui.micOpen)
        } finally { fixture.controller.dispose() }
    }

    @Test fun refusedPushToTalkRestoresOnlyTheMomentaryFaceAndKeepsTheCallLive() {
        val fixture = Fixture()
        try {
            fixture.live(micMuted = true, speakerMuted = false)
            fixture.controller.hold()
            val hold = fixture.transport.requests.last()
            assertTrue(fixture.controller.ui.holding)
            fixture.receive(response(hold, false))
            assertFalse(fixture.controller.ui.holding)
            assertTrue(fixture.controller.ui.micMuted)
            assertFalse(fixture.controller.ui.speakerMuted)
            assertTrue(fixture.controller.ui.connected)
            assertEquals("Server refused push to talk. Try again when it is ready.", fixture.controller.ui.message)
        } finally { fixture.controller.dispose() }
    }

    @Test fun muteIsImmediateStableOnItsPeerAndReconcilesWithoutASecondFaceChange() {
        val fixture = Fixture()
        try {
            fixture.live(micMuted = false, speakerMuted = false)
            fixture.controller.toggleMute("mic")
            assertTrue(fixture.controller.ui.micMuted)
            assertFalse(fixture.controller.ui.speakerMuted)
            assertTrue(fixture.controller.ui.micPending)
            val request = fixture.transport.requests.last()
            fixture.receive(response(request, true))
            assertTrue(fixture.controller.ui.micMuted)
            assertFalse(fixture.controller.ui.speakerMuted)
            fixture.receive(state(micMuted = true, speakerMuted = false))
            assertTrue(fixture.controller.ui.micMuted)
            assertFalse(fixture.controller.ui.speakerMuted)
            assertFalse(fixture.controller.ui.micPending)
            assertTrue(fixture.controller.ui.connected)
        } finally { fixture.controller.dispose() }
    }

    @Test fun refusedMuteRollsBackOnlyTheTappedFaceAndKeepsTheCallLive() {
        val fixture = Fixture()
        try {
            fixture.live(micMuted = false, speakerMuted = false)
            fixture.controller.toggleMute("speaker")
            assertFalse(fixture.controller.ui.micMuted)
            assertTrue(fixture.controller.ui.speakerMuted)
            val request = fixture.transport.requests.last()
            fixture.receive(response(request, false))
            assertFalse(fixture.controller.ui.micMuted)
            assertFalse(fixture.controller.ui.speakerMuted)
            assertFalse(fixture.controller.ui.speakerPending)
            assertTrue(fixture.controller.ui.connected)
            assertEquals("Server refused a control. Start again when it is ready.", fixture.controller.ui.message)
        } finally { fixture.controller.dispose() }
    }

    @Test fun transportFailureRestoresTheTappedFaceBeforeUsingTheExistingFailurePath() {
        val fixture = Fixture()
        try {
            fixture.live(micMuted = false, speakerMuted = false)
            fixture.transport.accepts = false
            fixture.controller.toggleMute("speaker")
            assertTrue(fixture.published.any { it.running && !it.micMuted && !it.speakerMuted && !it.speakerPending })
            assertFalse(fixture.controller.ui.running)
            assertEquals("Connection or audio failed. Check your server, then start again.", fixture.controller.ui.message)
        } finally { fixture.controller.dispose() }
    }

    private class Fixture {
        val published = mutableListOf<CallUi>()
        lateinit var transport: FakeTransport
        lateinit var peer: PeerEvents
        val controller = CallController(RuntimeEnvironment.getApplication(),
            mediaFactory = { events -> peer = events; FakeMedia() },
            transportFactory = { _, events -> FakeTransport(events).also { transport = it } },
            permissionGranted = { true }, observeNetwork = false,
            onUiChanged = { published += it })
        private val credential = DeviceGrant.parse("""{"version":1,"endpoint":"wss://example.test/v2/client","token":"${"a".repeat(32)}.${"b".repeat(64)}"}""")
        private val session = "11111111-1111-4111-8111-111111111111"
        fun receive(value: String) { transport.events.text(value) {}; shadowOf(Looper.getMainLooper()).idle() }
        fun live(micMuted: Boolean, speakerMuted: Boolean) {
            controller.start(credential)
            transport.events.opened(); shadowOf(Looper.getMainLooper()).idle()
            receive(response(transport.requests.first(), true))
            receive("""{"v":3,"type":"client-media","message":{"type":"prepare","sessionId":"$session"}}""")
            peer.connected(session)
            receive(state(micMuted, speakerMuted))
            assertTrue(controller.ui.connected)
        }
    }
    private class FakeTransport(val events: TransportEvents) : CallTransport {
        var accepts = true
        val requests = mutableListOf<JsonObject>()
        override fun send(value: String): Boolean { requests += jsonObject(value); return accepts }
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
    private companion object {
        fun response(request: JsonObject, ok: Boolean) = if (ok)
            """{"v":3,"type":"response","id":"${request.string("id")}","ok":true,"result":null}"""
        else """{"v":3,"type":"response","id":"${request.string("id")}","ok":false,"error":{"message":"refused"}}"""
        fun state(micMuted: Boolean, speakerMuted: Boolean, micEffectiveMuted: Boolean = micMuted) = """{"v":3,"type":"state","state":{"codingActivity":"unknown","available":true,"phase":"live","mic":{"muted":$micMuted,"effectiveMuted":$micEffectiveMuted},"speaker":{"muted":$speakerMuted,"effectiveMuted":$speakerMuted}}}"""
    }
}
