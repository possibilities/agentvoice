package com.arthack.agentvoice

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.media.*
import android.os.Handler
import android.os.Looper
import org.webrtc.*
import org.webrtc.AudioTrack
import org.webrtc.audio.JavaAudioDeviceModule
import kotlin.math.sqrt

internal interface PeerEvents {
    fun offer(id: String, sdp: String)
    fun connected(id: String)
    fun disconnected(id: String)
    fun failed(id: String)
    fun fatal(message: String)
}

internal interface MediaEngine {
    val inputLevel: Float
    val outputLevel: Float
    fun prepare(id: String)
    fun answer(id: String, sdp: String)
    fun isActive(id: String): Boolean
    fun hasConnectedPeer(): Boolean
    fun gates(mic: Boolean, speaker: Boolean)
    fun close(id: String)
    fun stop()
}

/** Main-thread ownership; every asynchronous completion is checked against its exact peer. */
internal class VoicePeer(private val context: Context, private val events: PeerEvents) : MediaEngine {
    private val main = Handler(Looper.getMainLooper())
    private val audioManager = context.getSystemService(AudioManager::class.java)
    private var oldMode = AudioManager.MODE_NORMAL
    private var oldRoute: AudioDeviceInfo? = null
    private var selectedRoute: Int? = null
    private var focused = false
    private var closed = false
    private var factory: PeerConnectionFactory? = null
    private var adm: JavaAudioDeviceModule? = null
    private var source: AudioSource? = null
    private val peers = linkedMapOf<String, Peer>()
    private var active: String? = null
    private var pending: String? = null
    private var micOpen = false
    private var speakerOpen = false
    @Volatile override var inputLevel = 0f; private set
    @Volatile override var outputLevel = 0f; private set

    private class Peer(val id: String) {
        var pc: PeerConnection? = null
        var track: AudioTrack? = null
        var remote: AudioTrack? = null
        var data: DataChannel? = null
        var offered = false
        var localSet = false
        var answered = false
        var connected = false
    }
    private fun post(block: () -> Unit) { main.post { if (!closed) block() } }
    private fun current(peer: Peer) = !closed && peers[peer.id] === peer
    private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener({ change ->
            if (change != AudioManager.AUDIOFOCUS_GAIN && !closed) {
                mute(); events.fatal("Audio focus changed. Start again when you are ready.")
            }
        }, main).build()
    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            if (!closed && removedDevices.any { it.id == selectedRoute }) {
                mute(); events.fatal("Audio device disconnected. Check your output, then start again.")
            }
        }
    }

    private fun initialize() {
        if (factory != null) return
        if (audioManager.requestAudioFocus(focusRequest) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
            throw IllegalStateException("Audio focus unavailable")
        focused = true
        oldMode = audioManager.mode
        oldRoute = audioManager.communicationDevice
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val priorities = listOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        val bluetooth = context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        val available = audioManager.availableCommunicationDevices.filter {
            bluetooth || it.type !in setOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
        }
        val route = priorities.firstNotNullOfOrNull { type -> available.firstOrNull { it.type == type } }
        if (route != null) {
            check(audioManager.setCommunicationDevice(route))
            selectedRoute = route.id
        }
        audioManager.registerAudioDeviceCallback(devices, main)
        synchronized(VoicePeer::class.java) {
            if (!initialized) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context)
                    .setEnableInternalTracer(false)
                    .setInjectableLogger({ _, _, _ -> }, Logging.Severity.LS_NONE)
                    .createInitializationOptions())
                initialized = true
            }
        }
        val module = JavaAudioDeviceModule.builder(context)
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setUseHardwareAcousticEchoCanceler(true).setUseHardwareNoiseSuppressor(true)
            .setEnableVolumeLogger(false)
            .setSamplesReadyCallback { samples -> inputLevel = level(samples) }
            .setPlaybackSamplesReadyCallback { samples -> outputLevel = level(samples) }
            .setAudioRecordErrorCallback(object : JavaAudioDeviceModule.AudioRecordErrorCallback {
                override fun onWebRtcAudioRecordInitError(errorMessage: String) = audioError()
                override fun onWebRtcAudioRecordStartError(errorCode: JavaAudioDeviceModule.AudioRecordStartErrorCode, errorMessage: String) = audioError()
                override fun onWebRtcAudioRecordError(errorMessage: String) = audioError()
            })
            .setAudioTrackErrorCallback(object : JavaAudioDeviceModule.AudioTrackErrorCallback {
                override fun onWebRtcAudioTrackInitError(errorMessage: String) = audioError()
                override fun onWebRtcAudioTrackStartError(errorCode: JavaAudioDeviceModule.AudioTrackStartErrorCode, errorMessage: String) = audioError()
                override fun onWebRtcAudioTrackError(errorMessage: String) = audioError()
            }).createAudioDeviceModule()
        adm = module
        module.setMicrophoneMute(true)
        module.setSpeakerMute(true)
        factory = PeerConnectionFactory.builder().setAudioDeviceModule(module).createPeerConnectionFactory()
        source = factory!!.createAudioSource(MediaConstraints())
    }
    private fun audioError() = post { mute(); events.fatal("Audio stopped. Check microphone permission and your audio device.") }

    override fun prepare(id: String) {
        if (closed || peers.containsKey(id)) throw ProtocolFailure()
        initialize()
        pending?.let { close(it) }
        val peer = Peer(id)
        peers[id] = peer
        pending = id
        val config = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        val pc = factory!!.createPeerConnection(config, observer(peer)) ?: throw ProtocolFailure()
        peer.pc = pc
        val track = factory!!.createAudioTrack("audio-$id", source!!).apply { setEnabled(false) }
        peer.track = track
        pc.addTrack(track, listOf("agentvoice-$id")) ?: throw ProtocolFailure()
        peer.data = pc.createDataChannel("oai-events", DataChannel.Init())
        pc.createOffer(sdpObserver(peer, created = { offer ->
            pc.setLocalDescription(sdpObserver(peer, set = {
                peer.localSet = true
                gathered(peer)
            }), offer)
        }), MediaConstraints())
        main.postDelayed({
            if (current(peer) && !peer.offered) fail(peer)
        }, 15_000)
        main.postDelayed({
            if (current(peer) && !peer.connected) fail(peer)
        }, 30_000)
    }
    private fun gathered(peer: Peer) {
        if (!current(peer) || peer.offered || !peer.localSet ||
            peer.pc?.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) return
        val sdp = peer.pc?.localDescription?.description ?: return
        if (sdp.length !in 1..MAX_SDP_CHARS) { fail(peer); return }
        peer.offered = true
        events.offer(peer.id, sdp)
    }
    override fun answer(id: String, sdp: String) {
        val peer = peers[id] ?: return
        if (!peer.offered || peer.answered || pending != id) throw ProtocolFailure()
        peer.answered = true
        peer.pc?.setRemoteDescription(sdpObserver(peer), SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }
    private fun sdpObserver(peer: Peer, created: (SessionDescription) -> Unit = {}, set: () -> Unit = {}) =
        object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) = post { if (current(peer)) created(sdp) }
            override fun onSetSuccess() = post { if (current(peer)) set() }
            override fun onCreateFailure(error: String) = post { if (current(peer)) fail(peer) }
            override fun onSetFailure(error: String) = post { if (current(peer)) fail(peer) }
        }
    private fun observer(peer: Peer) = object : PeerConnection.Observer {
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) = post {
            if (!current(peer)) return@post
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> {
                    if (peer.connected) return@post
                    peer.connected = true
                    val previous = active
                    active = peer.id
                    pending = null
                    if (previous != null && previous != peer.id) close(previous)
                    // The controller opens gates only after acknowledging actual connectivity.
                    gates(false, false)
                    events.connected(peer.id)
                }
                PeerConnection.PeerConnectionState.DISCONNECTED -> {
                    peer.connected = false
                    mute()
                    events.disconnected(peer.id)
                    fail(peer)
                }
                PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> fail(peer)
                else -> Unit
            }
        }
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = post { gathered(peer) }
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = post {
            if (current(peer)) {
                (receiver.track() as? AudioTrack)?.let {
                    peer.remote = it
                    it.setEnabled(false)
                    it.setVolume(0.0)
                    gates(micOpen, speakerOpen)
                }
            }
        }
        override fun onDataChannel(dataChannel: DataChannel) { dataChannel.close(); dataChannel.dispose() }
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceCandidate(candidate: IceCandidate) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onRenegotiationNeeded() = Unit
    }
    private fun fail(peer: Peer) {
        if (!current(peer)) return
        val id = peer.id
        close(id)
        events.failed(id)
    }
    override fun isActive(id: String) = active == id
    override fun hasConnectedPeer() = active?.let { peers[it]?.connected } == true
    override fun gates(mic: Boolean, speaker: Boolean) {
        micOpen = mic && !closed
        speakerOpen = speaker && !closed
        adm?.setMicrophoneMute(!micOpen)
        adm?.setSpeakerMute(!speakerOpen)
        peers.values.forEach { peer ->
            peer.track?.setEnabled(micOpen && active == peer.id)
            peer.remote?.setEnabled(speakerOpen && active == peer.id)
            peer.remote?.setVolume(if (speakerOpen && active == peer.id) 1.0 else 0.0)
        }
        if (!micOpen) inputLevel = 0f
        if (!speakerOpen) outputLevel = 0f
    }
    private fun mute() = gates(false, false)
    override fun close(id: String) {
        val peer = peers.remove(id) ?: return
        val wasActive = active == id
        if (wasActive) active = null
        if (pending == id) pending = null
        cleanup(
            { if (wasActive) mute() },
            { peer.track?.setEnabled(false) }, { peer.remote?.setEnabled(false) },
            { peer.data?.close() }, { peer.pc?.close() }, { peer.data?.dispose() },
            { peer.pc?.dispose() }, { peer.track?.dispose() })
    }
    override fun stop() {
        if (closed) return
        closed = true
        main.removeCallbacksAndMessages(null)
        val closingPeers = peers.keys.toList()
        cleanup({ mute() }, *closingPeers.map { id -> { close(id) } }.toTypedArray(),
            { source?.dispose(); source = null }, { factory?.dispose(); factory = null },
            { adm?.release(); adm = null },
            { if (focused) audioManager.unregisterAudioDeviceCallback(devices) },
            {
                if (focused) {
                    val previous = oldRoute
                    if (previous != null && audioManager.availableCommunicationDevices.any { it.id == previous.id })
                        audioManager.setCommunicationDevice(previous)
                    else audioManager.clearCommunicationDevice()
                }
            },
            { if (focused) audioManager.mode = oldMode },
            { if (focused) audioManager.abandonAudioFocusRequest(focusRequest); focused = false })
    }
    companion object {
        private var initialized = false
        private fun cleanup(vararg actions: () -> Unit) {
            var failed = false
            for (action in actions) try { action() } catch (_: Exception) { failed = true }
            check(!failed) { "Audio cleanup failed" }
        }
        private fun level(samples: JavaAudioDeviceModule.AudioSamples): Float {
            if (samples.audioFormat != AudioFormat.ENCODING_PCM_16BIT) return 0f
            val data = samples.data
            if (data.size < 2) return 0f
            var sum = 0.0
            for (i in 0 until data.size - 1 step 2) {
                val value = ((data[i].toInt() and 255) or (data[i + 1].toInt() shl 8)).toShort().toDouble() / 32768.0
                sum += value * value
            }
            return sqrt(sum / (data.size / 2)).toFloat().coerceIn(0f, 1f)
        }
    }
}
