package com.arthack.agentvoice

import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
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
    client: OkHttpClient,
    private val credential: CallCredential,
    private val events: TransportEvents,
    private val keys: DeviceKeyProvider = AndroidDeviceKeyProvider(),
) : CallTransport {
    private val client = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()
    private val ended = AtomicBoolean(false)
    private val queuedBytes = AtomicInteger(0)
    private val challengeCall = AtomicReference<Call?>()
    private val socket = AtomicReference<WebSocket?>()

    init {
        when (credential) {
            is DeviceGrant -> openSocket(Request.Builder().url(credential.endpoint)
                .header("Authorization", "Bearer ${credential.token}")
                .header("Sec-WebSocket-Protocol", SUBPROTOCOL)
                .build())
            is PairedDevice -> requestChallenge(credential)
            else -> finish("Could not open saved device access. Repair this phone’s access.")
        }
    }

    private fun requestChallenge(device: PairedDevice) {
        val json = buildJsonObject { put("v", 1); put("deviceId", device.deviceId) }.toString()
        val request = try {
            Request.Builder()
                .url(endpointParts(device.endpoint).httpsUrl("/v2/auth/challenge"))
                .cacheControl(okhttp3.CacheControl.Builder().noCache().noStore().build())
                .post(json.toRequestBody("application/json; charset=utf-8".toMediaType()))
                .build()
        } catch (_: Exception) {
            finish("Could not open saved device access. Repair this phone’s access.")
            return
        }
        val call = client.newCall(request)
        call.timeout().timeout(15, TimeUnit.SECONDS)
        challengeCall.set(call)
        if (ended.get()) { call.cancel(); return }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (!ended.get()) finish("Could not connect securely. Check Tailscale and your server.")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (ended.get()) return
                    if (response.code != 200) {
                        finish(challengeFailure(response))
                        return
                    }
                    try {
                        val body = response.body?.byteStream()?.use {
                            readBoundedUtf8(it, MAX_CHALLENGE_RESPONSE_BYTES)
                        } ?: throw ProtocolFailure()
                        val challenge = parseDeviceChallenge(body)
                        val signature = keys.open(device.alias).sign(deviceAuthSigningBytes(device, challenge))
                        if (ended.get()) return
                        openSocket(Request.Builder().url(device.endpoint)
                            .header("X-AgentVoice-Auth", "1")
                            .header("X-AgentVoice-Device", device.deviceId)
                            .header("X-AgentVoice-Challenge", challenge.challengeId)
                            .header("X-AgentVoice-Signature", encodeBase64Url(signature))
                            .header("Sec-WebSocket-Protocol", SUBPROTOCOL)
                            .build())
                    } catch (_: Exception) {
                        finish("Could not open saved device access. Repair this phone’s access.")
                    }
                }
            }
        })
    }

    private fun openSocket(request: Request) {
        if (ended.get()) return
        val created = client.newWebSocket(request, object : WebSocketListener() {
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
                    finish("Server message exceeded the limit.")
                    webSocket.cancel()
                } else events.text(text) { queuedBytes.addAndGet(-bytes) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                finish("Unexpected server message. Update the app and server.")
                webSocket.cancel()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                finish(closeMessage(code))
                webSocket.cancel()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                finish(closeMessage(code))

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                finish(upgradeFailure(response))
            }
        })
        socket.set(created)
        if (ended.get()) created.cancel()
    }

    private fun finish(message: String) {
        if (ended.compareAndSet(false, true)) {
            challengeCall.get()?.cancel()
            socket.get()?.cancel()
            events.ended(message)
        }
    }

    override fun send(value: String): Boolean {
        val current = socket.get() ?: return false
        val bytes = value.toByteArray(Charsets.UTF_8).size
        return !ended.get() && bytes <= MAX_FRAME_BYTES &&
            current.queueSize() + bytes <= MAX_FRAME_BYTES && current.send(value)
    }

    override fun cancel() {
        ended.set(true)
        challengeCall.get()?.cancel()
        socket.get()?.cancel()
    }

    private fun challengeFailure(response: Response): String {
        val raw = response.header("X-AgentVoice-Error")
        if (response.code == 404 && raw == null) {
            return "Server configuration mismatch. Update AgentVoice on your desktop."
        }
        return try {
            val header = boundedErrorHeader(response) ?: throw ProtocolFailure()
            val body = response.body?.byteStream()?.use {
                readBoundedUtf8(it, MAX_CHALLENGE_RESPONSE_BYTES)
            } ?: throw ProtocolFailure()
            val error = parseChallengeError(response.code, body)
            requireWire(header == error)
            when (error) {
                "invalid_request" ->
                "Server protocol mismatch. Update the app and server."
                "device_unavailable" ->
                "This phone’s device access was removed. Ask the server owner to pair it again."
                "challenge_limited" ->
                "Server is busy. Try again when it is available."
                "pairing_unavailable" ->
                "Server is unavailable. Start again when it is ready."
                else -> throw ProtocolFailure()
            }
        } catch (_: Exception) {
            "Could not authenticate saved device access. Update the app and server."
        }
    }

    private fun upgradeFailure(response: Response?) = if (credential is DeviceGrant) when (response?.code) {
        401, 403 -> "Device access expired or was revoked. Ask the server owner to repair this phone’s access."
        429 -> "Server is busy. Try again when it is available."
        404, 421, 426 -> "Server configuration mismatch. Check your device grant."
        else -> "Could not connect securely. Check Tailscale and your server."
    } else {
        val error = try { response?.let(::boundedErrorHeader) } catch (_: ProtocolFailure) { null }
        when {
            response?.code == 401 && error == "device_auth_failed" ->
                "Could not authenticate saved device access. Start again; if this continues, repair this phone’s access."
            response?.code == 403 && error == "device_revoked" ->
                "This phone’s device access was revoked. Ask the server owner to pair it again."
            response?.code == 503 && error == "pairing_unavailable" ->
                "Server is unavailable. Start again when it is ready."
            else -> "Could not authenticate saved device access. Update the app and server."
        }
    }

    private fun closeMessage(code: Int) = when (code) {
        4403 -> "Device access expired or was revoked. Ask the server owner to repair this phone’s access."
        4408 -> "Connection timed out. Check Tailscale, then start again."
        1013 -> "Server is unavailable. Start again when it is ready."
        1000, 1001 -> "Call ended."
        else -> "Connection ended. Check your server, then start again."
    }
}
