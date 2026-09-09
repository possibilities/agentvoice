package com.arthack.agentvoice

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.*
import okio.ByteString

internal fun secureHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
    .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
    .writeTimeout(10, TimeUnit.SECONDS).build()

internal interface TransportEvents {
    fun opened()
    fun text(value: String, consumed: () -> Unit)
    fun ended(message: String)
}

internal interface CallTransport {
    fun send(value: String): Boolean
    fun cancel()
}

internal class SecureTransport(
    client: OkHttpClient, grant: DeviceGrant, private val events: TransportEvents,
) : CallTransport {
    private val ended = AtomicBoolean(false)
    private val queuedBytes = AtomicInteger(0)
    private val socket = client.newWebSocket(Request.Builder().url(grant.endpoint)
        .header("Authorization", "Bearer ${grant.token}")
        .header("Sec-WebSocket-Protocol", SUBPROTOCOL).build(), object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (ended.get()) { webSocket.cancel(); return }
            if (response.header("Sec-WebSocket-Protocol") != SUBPROTOCOL) {
                finish("Server protocol mismatch. Update the app and server.")
                webSocket.cancel()
            } else events.opened()
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (ended.get()) return
            val bytes = text.toByteArray(Charsets.UTF_8).size
            if (bytes > MAX_FRAME_BYTES || queuedBytes.addAndGet(bytes) > MAX_FRAME_BYTES) {
                finish("Server message exceeded the limit."); webSocket.cancel()
            } else events.text(text) { queuedBytes.addAndGet(-bytes) }
        }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            finish("Unexpected server message. Update the app and server."); webSocket.cancel()
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            finish(closeMessage(code)); webSocket.cancel()
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(closeMessage(code))
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            finish(when (response?.code) {
                401 -> "Device access expired or was revoked. Import a new grant."
                429 -> "Server is busy. Try again when it is available."
                404, 421, 426 -> "Server configuration mismatch. Check your device grant."
                else -> "Could not connect securely. Check Tailscale and your server."
            })
        }
    })
    private fun finish(message: String) { if (ended.compareAndSet(false, true)) events.ended(message) }
    override fun send(value: String): Boolean = !ended.get() &&
        value.toByteArray(Charsets.UTF_8).size <= MAX_FRAME_BYTES &&
        socket.queueSize() + value.toByteArray(Charsets.UTF_8).size <= MAX_FRAME_BYTES && socket.send(value)
    override fun cancel() { ended.set(true); socket.cancel() }
    private fun closeMessage(code: Int) = when (code) {
        4403 -> "Device access expired or was revoked. Import a new grant."
        4408 -> "Connection timed out. Check Tailscale, then start again."
        1013 -> "Server is unavailable. Start again when it is ready."
        1000, 1001 -> "Call ended."
        else -> "Connection ended. Check your server, then start again."
    }
}
