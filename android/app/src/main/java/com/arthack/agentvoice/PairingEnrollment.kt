package com.arthack.agentvoice

import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

internal class PairingEnrollment(
    client: OkHttpClient,
    private val store: DeviceCredentialStore,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private val client = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()

    /** A fresh scan creates and persists exactly one key/request tuple before any network I/O. */
    suspend fun enrollPairing(qrText: String, label: String, timeoutMs: Long = 15_000): PairedDevice {
        val qr = try { PairingQr.parse(qrText) }
        catch (_: ProtocolFailure) { throw PairingFailure(PairingProblem.InvalidQr) }
        if (qr.isExpired(nowMs())) throw PairingFailure(PairingProblem.ExpiredQr)
        val normalized = try { normalizePairingLabel(label) }
        catch (_: ProtocolFailure) { throw PairingFailure(PairingProblem.InvalidRequest) }
        val pending = withContext(Dispatchers.IO) { store.prepare(qr, normalized) }
        return submit(pending, timeoutMs)
    }

    /** Recovery deliberately ignores the five-minute QR expiry and reuses the persisted tuple. */
    suspend fun retryPairing(timeoutMs: Long = 15_000): PairedDevice = submit(
        withContext(Dispatchers.IO) { store.pendingForRetry() }, timeoutMs,
    )

    private suspend fun submit(pending: PendingPairing, timeoutMs: Long): PairedDevice {
        val result = try {
            val response = postJson(client, pending.qr.pairingUrl, pending.requestJson(),
                MAX_PAIRING_RESPONSE_BYTES, timeoutMs)
            when (response.code) {
                200, 201 -> {
                    requireWire(response.errorHeader == null)
                    parsePairingResult(response.body)
                }
                400, 401, 409, 429, 503 -> {
                    val problem = try { parsePairingError(response.code, response.body) }
                    catch (_: ProtocolFailure) { PairingProblem.Protocol }
                    if (problem == PairingProblem.Protocol || response.errorHeader != problem.wireCode()) {
                        throw PairingFailure(PairingProblem.Protocol)
                    }
                    throw PairingFailure(problem)
                }
                else -> throw PairingFailure(PairingProblem.Protocol)
            }
        } catch (error: PairingFailure) {
            throw error
        } catch (_: ProtocolFailure) {
            throw PairingFailure(PairingProblem.Protocol)
        } catch (_: IOException) {
            throw PairingFailure(PairingProblem.Unreachable)
        }
        return withContext(NonCancellable + Dispatchers.IO) { store.complete(pending, result) }
    }
}

internal data class BoundedHttpResponse(val code: Int, val body: String, val errorHeader: String?)

internal suspend fun postJson(
    client: OkHttpClient,
    url: String,
    json: String,
    maximumResponseBytes: Int,
    timeoutMs: Long,
): BoundedHttpResponse {
    requireWire(timeoutMs in 1..60_000)
    val requestBytes = json.toByteArray(Charsets.UTF_8)
    requireWire(requestBytes.size in 1..MAX_PAIRING_RESPONSE_BYTES)
    val request = Request.Builder()
        .url(url)
        .cacheControl(okhttp3.CacheControl.Builder().noCache().noStore().build())
        .post(requestBytes.toRequestBody(jsonMediaType))
        .build()
    return withTimeout(timeoutMs) {
        suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
            val finished = AtomicBoolean(false)
            continuation.invokeOnCancellation {
                finished.set(true)
                call.cancel()
            }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    if (finished.compareAndSet(false, true)) continuation.resumeWithException(error)
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        try {
                            val body = response.body?.byteStream()?.use {
                                readBoundedUtf8(it, maximumResponseBytes)
                            } ?: throw ProtocolFailure()
                            val bounded = BoundedHttpResponse(
                                response.code, body, boundedErrorHeader(response))
                            if (finished.compareAndSet(false, true)) {
                                continuation.resume(bounded)
                            }
                        } catch (error: Exception) {
                            if (finished.compareAndSet(false, true)) continuation.resumeWithException(error)
                        }
                    }
                }
            })
        }
    }
}

internal fun readBoundedUtf8(input: InputStream, maximumBytes: Int): String {
    requireWire(maximumBytes > 0)
    val bytes = ByteArray(maximumBytes + 1)
    var count = 0
    while (count < bytes.size) {
        val read = input.read(bytes, count, bytes.size - count)
        if (read < 0) break
        if (read == 0) throw ProtocolFailure()
        count += read
    }
    requireWire(count in 1..maximumBytes)
    return try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes, 0, count)).toString()
    } catch (_: Exception) {
        throw ProtocolFailure()
    } finally {
        bytes.fill(0)
    }
}
