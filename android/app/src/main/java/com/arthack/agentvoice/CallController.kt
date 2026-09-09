package com.arthack.agentvoice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.UUID
import kotlinx.serialization.json.*

internal data class CallUi(
    val running: Boolean = false,
    val connected: Boolean = false,
    val phase: String = "Ready",
    val message: String? = null,
    val micMuted: Boolean = true,
    val speakerMuted: Boolean = true,
    val micOpen: Boolean = false,
    val speakerOpen: Boolean = false,
    val canHold: Boolean = false,
    val holding: Boolean = false,
    val controlsPending: Boolean = false,
    val inputLevel: Float = 0f,
    val outputLevel: Float = 0f,
)

internal class CallController(
    private val context: Context,
    private val mediaFactory: (PeerEvents) -> MediaEngine = { VoicePeer(context, it) },
    private val transportFactory: ((DeviceGrant, TransportEvents) -> CallTransport)? = null,
    private val permissionGranted: () -> Boolean = {
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    },
    private val observeNetwork: Boolean = true,
) {
    var ui by mutableStateOf(CallUi()); private set
    private val main = Handler(Looper.getMainLooper())
    private val http = secureHttpClient()
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var generation = 0L
    private var transport: CallTransport? = null
    private var media: MediaEngine? = null
    private var ledger: WireLedger? = null
    private var gate = AudioGate()
    private var opened = false
    private var admitted = false
    private var hasState = false
    private var holdRevision = 0L
    private var cleanupFailed = false
    private data class Ack(val action: String, val target: String? = null, val revision: Long = 0)
    private val acknowledgements = mutableMapOf<String, Ack>()
    private val prepared = linkedSetOf<String>()

    fun start(grant: DeviceGrant) {
        if (cleanupFailed) { ui = CallUi(message = "Audio cleanup failed. Close and reopen AgentVoice."); return }
        if (ui.running) return
        stop()
        val epoch = generation
        gate = AudioGate()
        opened = false
        admitted = false
        hasState = false
        ledger = WireLedger(SystemClock::elapsedRealtime)
        ui = CallUi(running = true, phase = "Connecting")
        fun dispatch(block: () -> Unit) { main.post { if (generation == epoch && ui.running) guarded(block) } }
        media = mediaFactory(object : PeerEvents {
            override fun offer(id: String, sdp: String) = guarded {
                if (generation == epoch) send("client-media", buildJsonObject {
                    put("type", "offer"); put("sessionId", id); put("sdp", sdp)
                })
            }
            override fun connected(id: String) = guarded {
                if (generation != epoch) return@guarded
                gate.connected = true
                send("client-media", buildJsonObject { put("type", "connected"); put("sessionId", id) })
                refresh()
            }
            override fun disconnected(id: String) {
                if (generation != epoch) return
                release()
                gate.connected = false
                refresh()
            }
            override fun failed(id: String) = guarded {
                if (generation != epoch) return@guarded
                gate.connected = media?.hasConnectedPeer() == true
                release()
                send("client-media", buildJsonObject {
                    put("type", "failed"); put("sessionId", id); put("detail", "Android media connection failed")
                })
                refresh()
            }
            override fun fatal(message: String) { if (generation == epoch) stop(message) }
        })
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onLost(network: Network) = dispatch {
                stop("Network changed. Check Tailscale, then start again.")
            }
        }
        if (observeNetwork) {
            networkCallback = callback
            connectivity.registerDefaultNetworkCallback(callback)
        }
        val transportEvents = object : TransportEvents {
            override fun opened() = dispatch {
                opened = true
                send("call", buildJsonObject { put("clientId", UUID.randomUUID().toString()) })
            }
            override fun text(value: String, consumed: () -> Unit) {
                main.post {
                    try { if (generation == epoch && ui.running) guarded { receive(value) } }
                    finally { consumed() }
                }
            }
            override fun ended(message: String) = dispatch { stop(message) }
        }
        transport = transportFactory?.invoke(grant, transportEvents) ?: SecureTransport(http, grant, transportEvents)
        main.postDelayed({
            if (generation == epoch && !opened) stop("Could not connect securely. Check Tailscale and your server.")
        }, 15_000)
        tick(epoch)
    }

    private fun send(method: String, params: JsonObject, ack: Ack? = null) {
        val request = ledger?.request(method, params) ?: throw ProtocolFailure()
        if (ack != null) acknowledgements[request.id] = ack
        requireWire(transport?.send(request.text) == true)
    }
    private fun receive(text: String) {
        ledger!!.receive()
        when (val frame = parseFrame(text)) {
            is ServerFrame.Ping -> requireWire(transport!!.send(ledger!!.pong(frame.nonce)))
            is ServerFrame.Response -> {
                val method = ledger!!.response(frame.id)
                val ack = acknowledgements.remove(frame.id)
                if (!frame.ok) {
                    stop(if (method == "call") "Call unavailable. The server may be busy or closing a call."
                        else "Server refused a control. Start again when it is ready.")
                    return
                }
                if (method == "call") admitted = true
                if (ack?.action == "mute") gate.acknowledgeMute(ack.target!!)
                if (ack?.action == "hold" && ack.revision == holdRevision) gate.acknowledgeHold()
                refresh()
            }
            is ServerFrame.State -> {
                hasState = true
                gate.state(frame.value)
                // Runtime replacement may stop a voice session while this call remains owned.
                if (frame.value.phase == "failed" || frame.value.phase == "stopped") release()
                refresh()
            }
            is ServerFrame.Media -> when (frame.type) {
                "prepare" -> {
                    requireWire(prepared.add(frame.sessionId))
                    if (prepared.size > 256) prepared.remove(prepared.first())
                    media!!.prepare(frame.sessionId)
                }
                "answer" -> media!!.answer(frame.sessionId, frame.sdp!!)
                "close" -> {
                    val wasActive = media!!.isActive(frame.sessionId)
                    media!!.close(frame.sessionId)
                    if (wasActive) { release(); gate.connected = false; refresh() }
                }
                "state" -> {
                    // Session-scoped state must never change a successor's devices.
                    if (media!!.isActive(frame.sessionId)) {
                        gate.state(gate.state.copy(mic = frame.mic!!, speaker = frame.speaker!!))
                        refresh()
                    }
                }
            }
        }
    }
    private fun tick(epoch: Long) {
        if (generation != epoch || !ui.running) return
        if (!permissionGranted()) {
            stop("Microphone permission was removed. Allow it to start again.")
            return
        }
        guarded { ledger!!.checkLiveness() }
        if (generation != epoch || !ui.running) return
        val peer = media
        ui = ui.copy(inputLevel = if (gate.micOpen) peer?.inputLevel ?: 0f else 0f,
            outputLevel = if (gate.speakerOpen) peer?.outputLevel ?: 0f else 0f)
        main.postDelayed({ tick(epoch) }, 50)
    }
    fun toggleMute(target: String) = guarded {
        if (!ui.connected || gate.controlsPending) return@guarded
        release()
        val muted = if (target == "mic") !gate.state.mic.muted else !gate.state.speaker.muted
        gate.intent(target, muted)
        refresh()
        send("input", command("mute", target, muted), Ack("mute", target))
    }
    fun hold() = guarded {
        if (!gate.hold()) return@guarded
        holdRevision++
        send("input", command("hold"), Ack("hold", revision = holdRevision))
        refresh()
    }
    fun release() {
        val held = gate.release()
        holdRevision++
        // Close local capture before writing or awaiting any response.
        media?.gates(gate.micOpen && admitted, gate.speakerOpen && admitted)
        if (held && ui.running) guarded { send("input", command("release")) }
        refresh()
    }
    private fun refresh() {
        if (!ui.running) return
        val live = admitted && hasState && gate.state.available && gate.connected && gate.state.phase == "live"
        media?.gates(admitted && gate.micOpen, admitted && gate.speakerOpen)
        ui = ui.copy(connected = live,
            phase = when {
                live -> "Connected"
                gate.state.phase == "failed" -> "Voice unavailable"
                gate.state.phase == "stopped" && hasState -> "Voice stopped"
                gate.state.phase == "negotiating" -> "Connecting voice"
                else -> "Connecting"
            },
            micMuted = gate.state.mic.muted, speakerMuted = gate.state.speaker.muted,
            micOpen = admitted && gate.micOpen, speakerOpen = admitted && gate.speakerOpen,
            canHold = admitted && gate.canHold, holding = gate.holding,
            controlsPending = gate.controlsPending)
    }
    private inline fun guarded(block: () -> Unit) {
        try { block() } catch (_: Exception) { stop("Connection or audio failed. Check your server, then start again.") }
    }
    fun stop(message: String? = null) {
        generation++
        gate.stop()
        main.removeCallbacksAndMessages(null)
        // Transport cancellation cannot wait for a media close handshake or peer disposal.
        runCatching { media?.gates(false, false) }.onFailure { cleanupFailed = true }
        transport?.cancel(); transport = null
        runCatching { media?.stop() }.onFailure { cleanupFailed = true }; media = null
        networkCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }; networkCallback = null
        ledger = null
        acknowledgements.clear()
        prepared.clear()
        ui = CallUi(phase = if (message == null) "Ready" else "Disconnected", message =
            if (cleanupFailed) "Audio cleanup failed. Close and reopen AgentVoice." else message)
    }
    fun dispose() {
        stop()
        http.connectionPool.evictAll()
        http.dispatcher.executorService.shutdown()
    }
}
