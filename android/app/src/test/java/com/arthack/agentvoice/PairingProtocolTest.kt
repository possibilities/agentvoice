package com.arthack.agentvoice

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingProtocolTest {
    private val fixture = jsonObject(requireNotNull(javaClass.getResourceAsStream("/pairing-v1.json")) {
        "Missing shared pairing-v1.json fixture"
    }.bufferedReader().use { it.readText() })
    private val qrObject get() = fixture.obj("qr")
    private val proof get() = fixture.obj("deviceProof")
    private val enrollment get() = qrObject.obj("value").string("enrollment")
    private val qr get() = qrObject.string("payload")

    @Test fun qrUsesExactCanonicalPayloadAndDerivedHttpsAuthority() {
        val parsed = PairingQr.parse(qr)
        assertEquals("PairingQr(redacted)", parsed.toString())
        assertFalse(parsed.toString().contains(enrollment))
        assertEquals("voice.example:48414", parsed.authority)
        assertEquals(qrObject.string("pairUrl"), parsed.pairingUrl)
        assertFalse(parsed.isExpired(1_800_000_299_999))
        assertTrue(parsed.isExpired(1_800_000_300_000))

        for (invalid in listOf(
            qr.removePrefix(PAIRING_QR_PREFIX),
            qr.replace("{\"v\":1,\"endpoint\"", "{ \"v\":1,\"endpoint\""),
            qr.replace(
                "{\"v\":1,\"endpoint\":\"wss://voice.example:48414/v2/client\"",
                "{\"endpoint\":\"wss://voice.example:48414/v2/client\",\"v\":1",
            ),
            qr.replace("}", ",\"extra\":true}"),
            qr.replace("agentvoice-pair:v1:", "agentvoice-pair:v2:"),
        )) assertThrows(ProtocolFailure::class.java) { PairingQr.parse(invalid) }
        assertThrows(ProtocolFailure::class.java) {
            PairingQr.parse(qr + "x".repeat(MAX_PAIRING_QR_BYTES))
        }
    }

    @Test fun authorityCanonicalizesDefaultPortAndIpv6() {
        assertEquals("voice.example", endpointParts("wss://Voice.Example:443/v2/client").authority)
        val ipv6 = endpointParts("wss://[2001:db8::1]:48414/v2/client")
        assertEquals("[2001:db8::1]:48414", ipv6.authority)
        assertEquals("https://[2001:db8::1]:48414/v2/auth/challenge",
            ipv6.httpsUrl("/v2/auth/challenge"))
        assertEquals("[2001:db8::1]:48414",
            endpointParts("wss://[2001:0db8:0:0:0:0:0:1]:48414/v2/client").authority)
    }

    @Test fun qrRejectsEndpointsThatAreValidButNotCanonicalWireUrls() {
        for (endpoint in listOf(
            "wss://Voice.Example:48414/v2/client",
            "wss://voice.example:443/v2/client",
            "wss://[2001:0db8:0:0:0:0:0:1]:48414/v2/client",
        )) {
            assertThrows(ProtocolFailure::class.java) { PairingQr.parse(qrForEndpoint(endpoint)) }
            endpointParts(endpoint)
        }
        assertEquals("[2001:db8::1]:48414",
            PairingQr.parse(qrForEndpoint("wss://[2001:db8::1]:48414/v2/client")).authority)
    }

    @Test fun labelIsNfcBoundedByScalarsAndRejectsControls() {
        assertEquals("é", normalizePairingLabel("e\u0301"))
        assertEquals("🙂".repeat(80), normalizePairingLabel("🙂".repeat(80)))
        assertThrows(ProtocolFailure::class.java) { normalizePairingLabel("") }
        assertThrows(ProtocolFailure::class.java) { normalizePairingLabel("🙂".repeat(81)) }
        assertThrows(ProtocolFailure::class.java) { normalizePairingLabel("phone\n") }
        assertThrows(ProtocolFailure::class.java) { normalizePairingLabel("phone\ud800") }
    }

    @Test fun signingBytesAndSignatureMatchTheSharedInteropVector() {
        val publicKeyText = proof.string("publicKey")
        val signatureText = proof.string("signature")
        val device = PairedDevice(qrObject.obj("value").string("endpoint"), "test-key",
            proof.string("deviceId"), "01234567-89ab-4def-8123-456789abcdef")
        val challenge = DeviceChallenge(proof.string("challengeId"),
            decodeBase64Url(proof.string("nonce"), 32), 31_000, 1_000)
        val signingBytes = deviceAuthSigningBytes(device, challenge)
        assertEquals(proof.string("signingBytesHex"), signingBytes.hex())
        assertEquals(proof.string("signingBytesSha256"),
            MessageDigest.getInstance("SHA-256").digest(signingBytes).hex())

        val key = KeyFactory.getInstance("EC").generatePublic(
            X509EncodedKeySpec(decodeBase64Url(publicKeyText, 384)))
        assertTrue(Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(signingBytes)
            verify(decodeBase64Url(signatureText, 80))
        })
    }

    @Test fun challengeRequiresExactCanonicalBase64AndThirtySecondMaximumTtl() {
        val text = """{"v":1,"challengeId":"AQIDBAUGBwgJCgsMDQ4PEA","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","expiresAt":31000,"serverTime":1000}"""
        assertArrayEquals(ByteArray(32) { it.toByte() }, parseDeviceChallenge(text).nonce)
        assertThrows(ProtocolFailure::class.java) {
            parseDeviceChallenge(text.replace("31000", "31001"))
        }
        assertThrows(ProtocolFailure::class.java) {
            parseDeviceChallenge(text.replace("AQIDBAUGBwgJCgsMDQ4PEA", "AQIDBAUGBwgJCgsMDQ4PEA="))
        }
    }

    @Test fun pairingErrorsRequireTheExactStatusAndCodeTuple() {
        assertEquals(PairingProblem.InvalidEnrollment, parsePairingError(401,
            """{"v":1,"error":{"code":"invalid_enrollment"}}"""))
        assertEquals(PairingProblem.EnrollmentConsumed, parsePairingError(409,
            """{"v":1,"error":{"code":"enrollment_consumed"}}"""))
        assertEquals(PairingProblem.DeviceUnavailable, parsePairingError(409,
            """{"v":1,"error":{"code":"device_unavailable"}}"""))
        assertThrows(ProtocolFailure::class.java) {
            parsePairingError(404, """{"v":1,"error":{"code":"device_unavailable"}}""")
        }
    }

    @Test fun pendingPairingDiagnosticsRedactTheEnrollmentTuple() {
        val pending = PendingPairing(PairingQr.parse(qr),
            "01234567-89ab-4def-8123-456789abcdef", "Phone", "test-key",
            encodeBase64Url(ByteArray(91) { it.toByte() }))
        assertEquals("PendingPairing(redacted)", pending.toString())
        assertFalse(pending.toString().contains(enrollment))
        assertFalse(PairingStoredState.Pending(pending).toString().contains(enrollment))
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    private fun qrForEndpoint(endpoint: String) = PAIRING_QR_PREFIX +
        """{"v":1,"endpoint":"$endpoint","enrollment":"$enrollment","expiresAt":1800000300000}"""
}
