package com.arthack.agentvoice

import java.io.ByteArrayOutputStream
import java.net.URI
import java.text.Normalizer
import java.util.Base64
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl

internal const val PAIRING_QR_PREFIX = "agentvoice-pair:v1:"
internal const val MAX_PAIRING_QR_BYTES = 2048
internal const val MAX_PAIRING_RESPONSE_BYTES = 4096
internal const val MAX_CHALLENGE_RESPONSE_BYTES = 512
private val lowerUuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
private val deviceIdPattern = Regex("^[0-9a-f]{32}$")
private val enrollmentPattern = Regex("^[0-9a-f]{32}\\.[0-9a-f]{64}$")
private val base64UrlPattern = Regex("^[A-Za-z0-9_-]+$")

internal interface CallCredential {
    val endpoint: String
}

/** The private key is named by alias and remains nonexportable in Android Keystore. */
internal class PairedDevice internal constructor(
    override val endpoint: String,
    val alias: String,
    val deviceId: String,
    val serverId: String,
) : CallCredential {
    init {
        endpointParts(endpoint)
        requireWire(alias.length in 1..200 && alias.none { it.code < 0x20 || it.code == 0x7f })
        requireWire(deviceIdPattern.matches(deviceId) && lowerUuid.matches(serverId))
    }

    override fun toString() = "PairedDevice(redacted)"
}

internal class PairingQr internal constructor(
    val endpoint: String,
    val enrollment: String,
    val expiresAt: Long,
) {
    val authority: String get() = endpointParts(endpoint).authority
    val pairingUrl: String get() = endpointParts(endpoint).httpsUrl("/v2/pair")
    fun isExpired(nowMs: Long): Boolean = expiresAt <= nowMs
    override fun toString() = "PairingQr(redacted)"

    companion object {
        fun parse(value: String): PairingQr {
            requireWire(value.length <= MAX_PAIRING_QR_BYTES &&
                value.toByteArray(Charsets.UTF_8).size <= MAX_PAIRING_QR_BYTES)
            requireWire(value.startsWith(PAIRING_QR_PREFIX))
            val objectValue = jsonObject(value.substring(PAIRING_QR_PREFIX.length))
            objectValue.fields("v", "endpoint", "enrollment", "expiresAt")
            objectValue.version(1)
            val endpoint = objectValue.string("endpoint")
            val endpointParts = endpointParts(endpoint)
            requireWire(endpoint == endpointParts.wssUrl("/v2/client"))
            val enrollment = objectValue.string("enrollment")
            requireWire(enrollmentPattern.matches(enrollment))
            val expiresAt = objectValue.long("expiresAt")
            requireWire(expiresAt > 0)
            val qr = PairingQr(endpoint, enrollment, expiresAt)
            val canonical = buildJsonObject {
                put("v", 1)
                put("endpoint", qr.endpoint)
                put("enrollment", qr.enrollment)
                put("expiresAt", qr.expiresAt)
            }.toString()
            requireWire(value == PAIRING_QR_PREFIX + canonical)
            return qr
        }
    }
}

internal data class EndpointParts(val authority: String, private val hostForUrl: String) {
    fun httpsUrl(path: String): String = "https://$hostForUrl$path"
    fun wssUrl(path: String): String = "wss://$hostForUrl$path"
}

/** Matches the existing WSS endpoint restrictions and supplies the server's canonical authority. */
internal fun endpointParts(endpoint: String): EndpointParts {
    val uri = try { URI(endpoint) } catch (_: Exception) { throw ProtocolFailure() }
    requireWire(uri.scheme == "wss" && !uri.host.isNullOrEmpty() &&
        uri.rawPath == "/v2/client" && uri.rawUserInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null &&
        (uri.port == -1 || uri.port in 1..65535))
    val canonical = try { ("https" + endpoint.substring(3)).toHttpUrl() }
        catch (_: Exception) { throw ProtocolFailure() }
    requireWire(canonical.encodedPath == "/v2/client" && canonical.query == null &&
        canonical.fragment == null && canonical.username.isEmpty() && canonical.password.isEmpty())
    val host = canonical.host
    requireWire(host.isNotEmpty() && '%' !in host)
    val renderedHost = if (':' in host) "[$host]" else host
    val port = canonical.port.takeIf { it != 443 }
    return EndpointParts(renderedHost + (port?.let { ":$it" } ?: ""),
        renderedHost + (port?.let { ":$it" } ?: ""))
}

internal fun normalizePairingLabel(value: String): String {
    val normalized = Normalizer.normalize(value, Normalizer.Form.NFC)
    val scalarCount = normalized.codePointCount(0, normalized.length)
    requireWire(scalarCount in 1..80)
    var offset = 0
    while (offset < normalized.length) {
        val codePoint = normalized.codePointAt(offset)
        requireWire(codePoint !in 0xd800..0xdfff &&
            Character.getType(codePoint) != Character.CONTROL.toInt())
        offset += Character.charCount(codePoint)
    }
    return normalized
}

internal class PendingPairing internal constructor(
    val qr: PairingQr,
    val requestId: String,
    val label: String,
    val alias: String,
    val publicKey: String,
) {
    init {
        requireWire(lowerUuid.matches(requestId))
        requireWire(label == normalizePairingLabel(label))
        requireWire(alias.length in 1..200)
        requireWire(publicKey.length <= 512)
        decodeBase64Url(publicKey, 384)
    }

    fun requestJson(): String = buildJsonObject {
        put("v", 1)
        put("enrollment", qr.enrollment)
        put("requestId", requestId)
        put("label", label)
        put("publicKey", publicKey)
    }.toString().also { requireWire(it.toByteArray(Charsets.UTF_8).size <= MAX_PAIRING_RESPONSE_BYTES) }

    fun sameRequest(other: PendingPairing): Boolean =
        qr.endpoint == other.qr.endpoint && qr.enrollment == other.qr.enrollment &&
            qr.expiresAt == other.qr.expiresAt && requestId == other.requestId &&
            label == other.label && alias == other.alias && publicKey == other.publicKey

    override fun toString() = "PendingPairing(redacted)"
}

internal data class PairingResult(val deviceId: String, val serverId: String)

internal fun parsePairingResult(text: String): PairingResult {
    val objectValue = jsonObject(text)
    objectValue.fields("v", "deviceId", "serverId")
    objectValue.version(1)
    val deviceId = objectValue.string("deviceId")
    val serverId = objectValue.string("serverId")
    requireWire(deviceIdPattern.matches(deviceId) && lowerUuid.matches(serverId))
    return PairingResult(deviceId, serverId)
}

internal enum class PairingProblem {
    InvalidRequest, InvalidEnrollment, EnrollmentNotReady, EnrollmentConsumed,
    DeviceUnavailable, PairingLimited, PairingUnavailable, InvalidQr, ExpiredQr,
    Protocol, Unreachable,
}

internal class PairingFailure(val problem: PairingProblem) : Exception("Device pairing could not be completed")

internal fun parsePairingError(status: Int, text: String): PairingProblem {
    val objectValue = jsonObject(text)
    objectValue.fields("v", "error")
    objectValue.version(1)
    val error = objectValue.obj("error")
    error.fields("code")
    return when (status to error.string("code")) {
        400 to "invalid_request" -> PairingProblem.InvalidRequest
        401 to "invalid_enrollment" -> PairingProblem.InvalidEnrollment
        409 to "enrollment_not_ready" -> PairingProblem.EnrollmentNotReady
        409 to "enrollment_consumed" -> PairingProblem.EnrollmentConsumed
        409 to "device_unavailable" -> PairingProblem.DeviceUnavailable
        429 to "pairing_limited" -> PairingProblem.PairingLimited
        503 to "pairing_unavailable" -> PairingProblem.PairingUnavailable
        else -> throw ProtocolFailure()
    }
}

internal fun parseChallengeError(status: Int, text: String): String {
    val objectValue = jsonObject(text)
    objectValue.fields("v", "error")
    objectValue.version(1)
    val error = objectValue.obj("error")
    error.fields("code")
    val code = error.string("code")
    requireWire(status to code in setOf(
        400 to "invalid_request",
        404 to "device_unavailable",
        429 to "challenge_limited",
        503 to "pairing_unavailable",
    ))
    return code
}

internal fun PairingProblem.wireCode(): String? = when (this) {
    PairingProblem.InvalidRequest -> "invalid_request"
    PairingProblem.InvalidEnrollment -> "invalid_enrollment"
    PairingProblem.EnrollmentNotReady -> "enrollment_not_ready"
    PairingProblem.EnrollmentConsumed -> "enrollment_consumed"
    PairingProblem.DeviceUnavailable -> "device_unavailable"
    PairingProblem.PairingLimited -> "pairing_limited"
    PairingProblem.PairingUnavailable -> "pairing_unavailable"
    PairingProblem.InvalidQr, PairingProblem.ExpiredQr,
    PairingProblem.Protocol, PairingProblem.Unreachable -> null
}

internal fun boundedErrorHeader(response: okhttp3.Response): String? {
    val value = response.header("X-AgentVoice-Error") ?: return null
    requireWire(value.length in 1..64 && Regex("^[a-z_]+$").matches(value))
    return value
}

internal data class DeviceChallenge(
    val challengeId: String,
    val nonce: ByteArray,
    val expiresAt: Long,
    val serverTime: Long,
)

internal fun parseDeviceChallenge(text: String): DeviceChallenge {
    val objectValue = jsonObject(text)
    objectValue.fields("v", "challengeId", "nonce", "expiresAt", "serverTime")
    objectValue.version(1)
    val challengeId = objectValue.string("challengeId")
    val nonceText = objectValue.string("nonce")
    val challengeBytes = decodeBase64Url(challengeId, 16)
    val nonce = decodeBase64Url(nonceText, 32)
    requireWire(challengeBytes.size == 16 && nonce.size == 32)
    val expiresAt = objectValue.long("expiresAt")
    val serverTime = objectValue.long("serverTime")
    requireWire(serverTime > 0 && expiresAt > serverTime && expiresAt - serverTime <= 30_000)
    return DeviceChallenge(challengeId, nonce, expiresAt, serverTime)
}

internal fun deviceAuthSigningBytes(device: PairedDevice, challenge: DeviceChallenge): ByteArray {
    val output = ByteArrayOutputStream()
    output.write("AgentVoice device-auth v1".toByteArray(Charsets.US_ASCII))
    output.write(0)
    fun field(bytes: ByteArray) {
        requireWire(bytes.size <= 0xffff)
        output.write(bytes.size ushr 8)
        output.write(bytes.size and 0xff)
        output.write(bytes)
    }
    field(device.deviceId.toByteArray(Charsets.UTF_8))
    field(challenge.challengeId.toByteArray(Charsets.UTF_8))
    field(challenge.nonce)
    field("GET".toByteArray(Charsets.US_ASCII))
    field(endpointParts(device.endpoint).authority.toByteArray(Charsets.UTF_8))
    field("/v2/client".toByteArray(Charsets.US_ASCII))
    field(SUBPROTOCOL.toByteArray(Charsets.US_ASCII))
    return output.toByteArray()
}

internal fun encodeBase64Url(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

internal fun decodeBase64Url(value: String, maximumBytes: Int): ByteArray {
    requireWire(value.isNotEmpty() && value.length <= ((maximumBytes + 2) / 3) * 4 &&
        base64UrlPattern.matches(value))
    val bytes = try { Base64.getUrlDecoder().decode(value) } catch (_: Exception) { throw ProtocolFailure() }
    requireWire(bytes.size <= maximumBytes && encodeBase64Url(bytes) == value)
    return bytes
}

private fun JsonObject.long(name: String): Long {
    val value = get(name) as? JsonPrimitive ?: throw ProtocolFailure()
    requireWire(!value.isString)
    return value.longOrNull ?: throw ProtocolFailure()
}
