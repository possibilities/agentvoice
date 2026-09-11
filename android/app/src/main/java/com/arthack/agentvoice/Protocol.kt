package com.arthack.agentvoice

import java.net.URI
import kotlinx.serialization.json.*

internal const val MAX_FRAME_BYTES = 1024 * 1024
internal const val MAX_SDP_CHARS = 192 * 1024
internal const val SUBPROTOCOL = "agentvoice.v2"
internal const val FRONTEND_VERSION = 3

internal class ProtocolFailure : Exception("Incompatible server message")
internal fun requireWire(condition: Boolean) { if (!condition) throw ProtocolFailure() }
internal fun JsonObject.fields(vararg names: String) = requireWire(keys == names.toSet())
internal fun JsonObject.string(name: String): String {
    val value = get(name) as? JsonPrimitive ?: throw ProtocolFailure()
    requireWire(value.isString)
    return value.content
}
internal fun JsonObject.bool(name: String): Boolean {
    val value = get(name) as? JsonPrimitive ?: throw ProtocolFailure()
    requireWire(!value.isString)
    return value.booleanOrNull ?: throw ProtocolFailure()
}
internal fun JsonObject.obj(name: String) = get(name) as? JsonObject ?: throw ProtocolFailure()
internal fun JsonObject.version(number: Int) = requireWire(get("v") == JsonPrimitive(number))
internal fun jsonObject(text: String): JsonObject = try {
    // All protocol objects fit within six levels. Bound hostile nesting before parser recursion.
    var depth = 0
    var quoted = false
    var escaped = false
    text.forEach { char ->
        if (quoted) {
            if (escaped) escaped = false
            else if (char == '\\') escaped = true
            else if (char == '"') quoted = false
        } else when (char) {
            '"' -> quoted = true
            '{', '[' -> { depth++; requireWire(depth <= 12) }
            '}', ']' -> { depth--; requireWire(depth >= 0) }
        }
    }
    requireWire(depth == 0 && !quoted)
    Json.parseToJsonElement(text) as? JsonObject ?: throw ProtocolFailure()
} catch (_: Exception) { throw ProtocolFailure() }
private val uuid = Regex("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")

// Never use a data class: generated toString/copy/component methods would expose the grant.
internal class DeviceGrant private constructor(val endpoint: String, val token: String) {
    override fun toString() = "DeviceGrant(redacted)"
    companion object {
        fun parse(text: String): DeviceGrant {
            requireWire(text.toByteArray(Charsets.UTF_8).size <= 8192)
            val objectValue = jsonObject(text)
            objectValue.fields("version", "endpoint", "token")
            requireWire(objectValue["version"] == JsonPrimitive(1))
            val endpoint = objectValue.string("endpoint")
            val uri = try { URI(endpoint) } catch (_: Exception) { throw ProtocolFailure() }
            requireWire(uri.scheme == "wss" && !uri.host.isNullOrEmpty() &&
                uri.rawPath == "/v2/client" && uri.rawUserInfo == null &&
                uri.rawQuery == null && uri.rawFragment == null &&
                (uri.port == -1 || uri.port in 1..65535))
            val token = objectValue.string("token")
            requireWire(Regex("^[a-f0-9]{32}\\.[a-f0-9]{64}$").matches(token))
            return DeviceGrant(endpoint, token)
        }
    }
}

internal data class ChannelState(val muted: Boolean = true, val effectiveMuted: Boolean = true)
internal enum class CodingActivity(val wire: String) {
    Working("working"), Blocked("blocked"), Idle("idle"), Unknown("unknown");
    companion object {
        fun parse(value: String): CodingActivity = entries.firstOrNull { it.wire == value } ?: throw ProtocolFailure()
    }
}
internal data class VoiceState(
    val available: Boolean = false,
    val phase: String = "stopped",
    val mic: ChannelState = ChannelState(),
    val speaker: ChannelState = ChannelState(),
    val codingActivity: CodingActivity = CodingActivity.Unknown,
)
private fun channel(objectValue: JsonObject): ChannelState {
    objectValue.fields("muted", "effectiveMuted")
    return ChannelState(objectValue.bool("muted"), objectValue.bool("effectiveMuted"))
}

internal sealed interface ServerFrame {
    data class Ping(val nonce: String) : ServerFrame
    data class State(val value: VoiceState) : ServerFrame
    data class Response(val id: String, val ok: Boolean) : ServerFrame
    data class Media(val type: String, val sessionId: String, val sdp: String? = null,
        val mic: ChannelState? = null, val speaker: ChannelState? = null) : ServerFrame
}

internal fun parseFrame(text: String): ServerFrame {
    requireWire(text.toByteArray(Charsets.UTF_8).size <= MAX_FRAME_BYTES)
    val frame = jsonObject(text)
    frame.version(if (frame.string("type") == "ping") 2 else FRONTEND_VERSION)
    return when (frame.string("type")) {
        "ping" -> {
            frame.fields("v", "type", "nonce")
            val nonce = frame.string("nonce")
            requireWire(Regex("^[a-f0-9]{32}$").matches(nonce))
            ServerFrame.Ping(nonce)
        }
        "state" -> {
            frame.fields("v", "type", "state")
            val state = frame.obj("state")
            state.fields("available", "phase", "mic", "speaker", "codingActivity")
            val phase = state.string("phase")
            requireWire(phase in setOf("waiting-ready", "negotiating", "live", "failed", "stopped"))
            ServerFrame.State(VoiceState(state.bool("available"), phase,
                channel(state.obj("mic")), channel(state.obj("speaker")), CodingActivity.parse(state.string("codingActivity"))))
        }
        "response" -> {
            val ok = frame.bool("ok")
            frame.fields("v", "type", "id", "ok", if (ok) "result" else "error")
            val id = frame.string("id")
            requireWire(id.length in 1..128)
            // This owner sends call/input/client-media only; their result is null.
            if (ok) requireWire(frame["result"] == JsonNull)
            else { frame.obj("error").fields("message"); frame.obj("error").string("message") }
            ServerFrame.Response(id, ok)
        }
        "client-media" -> {
            frame.fields("v", "type", "message")
            val message = frame.obj("message")
            val type = message.string("type")
            val sessionId = message.string("sessionId")
            requireWire(uuid.matches(sessionId))
            when (type) {
                "prepare" -> message.fields("type", "sessionId")
                "answer" -> {
                    message.fields("type", "sessionId", "sdp")
                    requireWire(message.string("sdp").length in 1..MAX_SDP_CHARS)
                }
                "close" -> {
                    if (message.containsKey("reason")) {
                        message.fields("type", "sessionId", "reason")
                        requireWire(message.string("reason").length in 1..256)
                    } else message.fields("type", "sessionId")
                }
                "state" -> message.fields("type", "sessionId", "mic", "speaker")
                else -> throw ProtocolFailure()
            }
            ServerFrame.Media(type, sessionId,
                if (type == "answer") message.string("sdp") else null,
                if (type == "state") channel(message.obj("mic")) else null,
                if (type == "state") channel(message.obj("speaker")) else null)
        }
        else -> throw ProtocolFailure()
    }
}

internal fun command(action: String, target: String? = null, muted: Boolean? = null) = buildJsonObject {
    put("action", action)
    if (target != null) put("target", target)
    if (muted != null) put("muted", muted)
}

/** Per-connection bounds and correlation. No state is reused by a later call. */
internal class WireLedger(private val now: () -> Long) {
    private var nextId = 0L
    private val pending = mutableMapOf<String, Pair<String, Long>>()
    private val incoming = ArrayDeque<Long>()
    private val outgoing = ArrayDeque<Long>()
    private var lastPing = now()

    private fun rate(queue: ArrayDeque<Long>) {
        while (queue.isNotEmpty() && now() - queue.first() >= 10_000) queue.removeFirst()
        requireWire(queue.size < 256)
        queue.addLast(now())
    }
    fun receive() = rate(incoming)
    fun pong(nonce: String): String {
        lastPing = now()
        rate(outgoing)
        return buildJsonObject { put("v", 2); put("type", "pong"); put("nonce", nonce) }.toString()
    }
    data class Request(val id: String, val text: String)
    fun request(method: String, params: JsonObject): Request {
        requireWire(pending.size < 32)
        rate(outgoing)
        val id = (++nextId).toString()
        pending[id] = method to now()
        val text = buildJsonObject {
            put("v", FRONTEND_VERSION); put("type", "request"); put("id", id)
            put("method", method); put("params", params)
        }.toString()
        return Request(id, text)
    }
    fun response(id: String): String = pending.remove(id)?.first ?: throw ProtocolFailure()
    fun checkLiveness() {
        requireWire(now() - lastPing < 30_000)
        requireWire(pending.values.none { now() - it.second >= 30_000 })
    }
}
