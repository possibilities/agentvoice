package com.arthack.agentvoice

import java.util.UUID
import kotlinx.serialization.json.*

/** Identity is also the UI callback fence. Never log or persist the transport-bound token. */
internal class TakeoverChallenge internal constructor(internal val token: String) {
    override fun toString() = "TakeoverChallenge(redacted)"
}

/** One transport's admission attempt; confirmation is explicit and never replayed. */
internal class CallAdmission(private val clientId: String = UUID.randomUUID().toString()) {
    private var pending = false
    private var started = false
    private var challenge: TakeoverChallenge? = null

    fun initialRequest(): JsonObject {
        requireWire(!started)
        started = true
        pending = true
        return buildJsonObject { put("clientId", clientId); put("takeover", "confirm") }
    }

    fun response(token: String?): TakeoverChallenge? {
        requireWire(pending)
        pending = false
        challenge = token?.let(::TakeoverChallenge)
        return challenge
    }

    fun confirm(expected: TakeoverChallenge): JsonObject? {
        if (pending || challenge !== expected) return null
        challenge = null
        pending = true
        return buildJsonObject {
            put("clientId", clientId)
            put("takeover", buildJsonObject { put("token", expected.token) })
        }
    }
}

internal fun callAdmissionFailure(code: String?): String = when (code) {
    "media_detach_failed" -> "Audio cleanup failed. Your conversation and agent work are kept. Restart the server before connecting again."
    "takeover_in_progress" -> "Another client is moving voice. Wait for it to finish, then connect again."
    "takeover_stale", "invalid_takeover_token", "takeover_token_expired" ->
        "The voice connection changed. Connect again to review the current call."
    else -> "Call unavailable. The server may be busy or closing a call."
}
