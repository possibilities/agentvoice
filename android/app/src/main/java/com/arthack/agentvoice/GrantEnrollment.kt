package com.arthack.agentvoice

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal const val GRANT_QR_PREFIX = "agentvoice-grant:v1:"
internal const val MAX_GRANT_QR_BYTES = 2048

internal fun parseGrantQr(value: String): DeviceGrant {
    requireWire(value.length <= MAX_GRANT_QR_BYTES && value.toByteArray(Charsets.UTF_8).size <= MAX_GRANT_QR_BYTES)
    requireWire(value.startsWith(GRANT_QR_PREFIX))
    return DeviceGrant.parse(value.substring(GRANT_QR_PREFIX.length))
}

internal enum class GrantCheckProblem { Rejected, Busy, Protocol, Unreachable }
internal class GrantCheckFailure(val problem: GrantCheckProblem) : Exception("Device access could not be verified")

/** The authenticated upgrade sends no call, observer, control, or audio request. */
internal suspend fun verifyGrant(client: OkHttpClient, grant: DeviceGrant, timeoutMs: Long = 15_000) {
    withTimeout(timeoutMs) {
        suspendCancellableCoroutine<Unit> { continuation ->
            val finished = AtomicBoolean(false)
            val socket = AtomicReference<WebSocket?>()
            fun finish(problem: GrantCheckProblem?) {
                if (!finished.compareAndSet(false, true)) return
                socket.get()?.cancel()
                if (problem == null) continuation.resume(Unit)
                else continuation.resumeWithException(GrantCheckFailure(problem))
            }
            continuation.invokeOnCancellation { finished.set(true); socket.get()?.cancel() }
            if (finished.get()) return@suspendCancellableCoroutine
            val created = client.newWebSocket(Request.Builder().url(grant.endpoint)
                .header("Authorization", "Bearer ${grant.token}")
                .header("Sec-WebSocket-Protocol", SUBPROTOCOL).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    finish(if (response.header("Sec-WebSocket-Protocol") == SUBPROTOCOL) null else GrantCheckProblem.Protocol)
                    webSocket.cancel()
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    finish(when (response?.code) {
                        401, 403 -> GrantCheckProblem.Rejected
                        429 -> GrantCheckProblem.Busy
                        404, 421, 426 -> GrantCheckProblem.Protocol
                        else -> GrantCheckProblem.Unreachable
                    })
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(GrantCheckProblem.Unreachable)
            })
            socket.set(created)
            if (finished.get()) created.cancel()
        }
    }
}

/** Failure within one foreground visit never creates an automatic retry loop. */
internal class ForegroundConnectionPolicy {
    private var active = false
    private var attempted = false
    fun enter() { active = true; attempted = false }
    fun leave() { active = false }
    fun claim(loaded: Boolean, hasGrant: Boolean, resumed: Boolean, running: Boolean): Boolean {
        if (!active || attempted || !loaded || !hasGrant || !resumed || running) return false
        attempted = true
        return true
    }
}
