package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test
import org.webrtc.AudioTrack
import org.webrtc.audio.JavaAudioDeviceModule

/** Production gates, real Java mute setters, and non-native track sinks.
 * Constructor bypass is test-only: no Android service, native library or device is opened.
 */
class VoicePeerGateTest {
    private class Track(private val onSet: (Boolean) -> Unit = {}) : AudioTrack(1L) {
        var open = false
        var level = 0.0
        val transitions = mutableListOf<Boolean>()
        override fun setEnabled(enable: Boolean): Boolean {
            onSet(enable)
            if (open != enable) transitions += enable
            open = enable
            return true
        }
        override fun setVolume(value: Double) { level = value }
    }
    private class Fixture {
        val engine = allocate(VoicePeer::class.java) as VoicePeer
        val input = allocate(Class.forName("org.webrtc.audio.WebRtcAudioRecord"))
        val output = allocate(Class.forName("org.webrtc.audio.WebRtcAudioTrack"))
        val module = allocate(JavaAudioDeviceModule::class.java) as JavaAudioDeviceModule
        val peers = linkedMapOf<String, Any>()
        init {
            field(module, "audioInput", input)
            field(module, "audioOutput", output)
            field(engine, "adm", module)
            field(engine, "peers", peers)
            field(engine, "routeReady", true)
        }
        fun peer(id: String, local: Track = Track(), remote: Track = Track()): Pair<Track, Track> {
            val type = Class.forName("com.arthack.agentvoice.VoicePeer\$Peer")
            val peer = type.getDeclaredConstructor(String::class.java).apply { isAccessible = true }.newInstance(id)
            field(peer, "track", local); field(peer, "remote", remote)
            peers[id] = peer
            return local to remote
        }
        fun active(id: String?) = field(engine, "active", id)
        val micMuted get() = read(input, "microphoneMute") as Boolean
        val speakerMuted get() = read(output, "speakerMute") as Boolean
    }

    @Test fun micMutePreservesActiveTrackAndSpeakerAcrossRepeatedCycles() {
        val f = Fixture()
        val (local, remote) = f.peer("active")
        f.active("active")
        f.engine.gates(true, true)
        repeat(3) {
            f.engine.gates(false, true)
            assertTrue(f.micMuted)
            assertTrue(local.open)
            assertFalse(f.speakerMuted)
            assertTrue(remote.open)
            assertEquals(1.0, remote.level, 0.0)
            f.engine.gates(true, true)
            assertFalse(f.micMuted)
        }
        assertEquals(listOf(true), local.transitions)
    }

    @Test fun mutedActivationAppliesJavaPrivacyGateBeforeEnablingTrack() {
        val f = Fixture()
        f.peer("active", Track { enabled -> if (enabled) assertTrue(f.micMuted) })
        f.active("active")
        f.engine.gates(false, true)
        assertTrue(f.micMuted)
        assertFalse(f.speakerMuted)
    }

    @Test fun acceptedButUnconfirmedStartupRouteKeepsBothAudioGatesClosed() {
        val f = Fixture()
        val (local, remote) = f.peer("active")
        f.active("active")
        field(f.engine, "routeReady", false)

        f.engine.gates(true, true)

        assertTrue(f.micMuted)
        assertTrue(f.speakerMuted)
        assertTrue(local.open) // The continuous-input track carries Java ADM's zero PCM.
        assertFalse(remote.open)
        field(f.engine, "routeReady", true)
        f.engine.gates(true, true)
        assertFalse(f.micMuted)
        assertFalse(f.speakerMuted)
        assertTrue(remote.open)
    }

    @Test fun bothUserGatesMutedKeepOnlyActiveInputClockOpen() {
        val f = Fixture()
        val (local, remote) = f.peer("active")
        val (pending, pendingRemote) = f.peer("pending")
        f.active("active")
        f.engine.gates(false, false)
        assertTrue(f.micMuted); assertTrue(f.speakerMuted)
        assertTrue(local.open); assertFalse(remote.open)
        assertFalse(pending.open); assertFalse(pendingRemote.open)
        assertEquals(0.0, remote.level, 0.0)
    }

    @Test fun pendingAndRetiredPeersStayClosedWhileMutedSuccessorActivates() {
        val f = Fixture()
        val (old, oldRemote) = f.peer("old")
        val (pending, pendingRemote) = f.peer("pending")
        f.active("old")
        f.engine.gates(false, true)
        assertTrue(old.open); assertTrue(oldRemote.open)
        assertFalse(pending.open); assertFalse(pendingRemote.open)
        assertEquals(0.0, pendingRemote.level, 0.0)
        f.active("pending")
        f.engine.gates(false, true)
        assertTrue(f.micMuted)
        assertFalse(old.open); assertFalse(oldRemote.open)
        assertTrue(pending.open); assertTrue(pendingRemote.open)
        assertEquals(0.0, oldRemote.level, 0.0)
    }

    @Test fun speakerMuteAndClosedSessionPreserveTheirOwnGates() {
        val f = Fixture()
        val (local, remote) = f.peer("active")
        f.active("active")
        f.engine.gates(true, false)
        assertFalse(f.micMuted); assertTrue(f.speakerMuted)
        assertTrue(local.open); assertFalse(remote.open)
        assertEquals(0.0, remote.level, 0.0)
        field(f.engine, "closed", true)
        f.engine.gates(true, true)
        assertTrue(f.micMuted); assertTrue(f.speakerMuted)
        assertFalse(local.open); assertFalse(remote.open)
    }

    companion object {
        private val unsafeType = Class.forName("sun.misc.Unsafe")
        private val unsafe = unsafeType.getDeclaredField("theUnsafe").run {
            isAccessible = true; get(null)
        }
        private fun allocate(type: Class<*>): Any = unsafeType.getMethod("allocateInstance", Class::class.java).invoke(unsafe, type)!!
        private fun field(target: Any, name: String, value: Any?) = target.javaClass.getDeclaredField(name).run {
            isAccessible = true; set(target, value)
        }
        private fun read(target: Any, name: String): Any? = target.javaClass.getDeclaredField(name).run {
            isAccessible = true; get(target)
        }
    }
}
