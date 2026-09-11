package com.arthack.agentvoice

import java.security.KeyPairGenerator
import java.security.Signature
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairedSecureTransportTest {
    private class Events : TransportEvents {
        val queue = LinkedBlockingQueue<String>()
        override fun opened() { queue.add("open") }
        override fun text(value: String, consumed: () -> Unit) { queue.add(value); consumed() }
        override fun ended(message: String) { queue.add(message) }
        fun take() = queue.poll(5, TimeUnit.SECONDS) ?: error("Timed out")
    }

    private data class Fixture(val server: MockWebServer, val client: OkHttpClient)

    private fun fixture(): Fixture {
        val certificate = HeldCertificate.Builder().commonName("localhost")
            .addSubjectAlternativeName("localhost").build()
        val serverCertificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientCertificates = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply {
            useHttps(serverCertificates.sslSocketFactory(), false)
            start()
        }
        val client = secureHttpClient().newBuilder()
            .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager).build()
        return Fixture(server, client)
    }

    private fun device(server: MockWebServer) = PairedDevice(
        server.url("/v2/client").toString().replaceFirst("https:", "wss:"),
        "unopened-test-key", "00112233445566778899aabbccddeeff",
        "01234567-89ab-4def-8123-456789abcdef",
    )

    private val unopenedKeys = object : DeviceKeyProvider {
        override fun create(alias: String): DeviceSigningKey = error("must not create")
        override fun open(alias: String): DeviceSigningKey = error("must not open")
    }

    private fun signingKeys(): DeviceKeyProvider {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val key = object : DeviceSigningKey {
            override val alias = "unopened-test-key"
            override val publicKey = pair.public.encoded
            override fun sign(value: ByteArray) = Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private); update(value); sign()
            }
        }
        return object : DeviceKeyProvider {
            override fun create(alias: String): DeviceSigningKey = error("must not create")
            override fun open(alias: String) = key.also { assertEquals(key.alias, alias) }
        }
    }

    private fun close(fixture: Fixture) {
        fixture.client.connectionPool.evictAll()
        fixture.client.dispatcher.executorService.shutdown()
        fixture.server.shutdown()
    }

    @Test fun pairedTransportGetsOneChallengeThenUsesProofHeadersWithoutBearer() {
        val certificate = HeldCertificate.Builder().commonName("localhost")
            .addSubjectAlternativeName("localhost").build()
        val serverCertificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientCertificates = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply {
            useHttps(serverCertificates.sslSocketFactory(), false)
            start()
        }
        val client = secureHttpClient().newBuilder()
            .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager).build()
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val key = object : DeviceSigningKey {
            override val alias = "paired-test-key"
            override val publicKey = pair.public.encoded
            override fun sign(value: ByteArray) = Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private); update(value); sign()
            }
        }
        val keys = object : DeviceKeyProvider {
            override fun create(alias: String) = error("must not create")
            override fun open(alias: String): DeviceSigningKey {
                assertEquals(key.alias, alias)
                return key
            }
        }
        val endpoint = server.url("/v2/client").toString().replaceFirst("https:", "wss:")
        val device = PairedDevice(endpoint, key.alias, "00112233445566778899aabbccddeeff",
            "01234567-89ab-4def-8123-456789abcdef")
        val challengeId = "AQIDBAUGBwgJCgsMDQ4PEA"
        val nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"v":1,"challengeId":"$challengeId","nonce":"$nonce","expiresAt":31000,"serverTime":1000}"""))
        server.enqueue(MockResponse().setHeader("Sec-WebSocket-Protocol", SUBPROTOCOL)
            .withWebSocketUpgrade(object : WebSocketListener() {}))
        val events = Events()
        val transport = SecureTransport(client, device, events, keys)
        try {
            assertEquals("open", events.take())
            val challengeRequest = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals("/v2/auth/challenge", challengeRequest.path)
            assertEquals("""{"v":1,"deviceId":"${device.deviceId}"}""", challengeRequest.body.readUtf8())
            assertNull(challengeRequest.getHeader("Authorization"))

            val upgrade = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals("/v2/client", upgrade.path)
            assertEquals("1", upgrade.getHeader("X-AgentVoice-Auth"))
            assertEquals(device.deviceId, upgrade.getHeader("X-AgentVoice-Device"))
            assertEquals(challengeId, upgrade.getHeader("X-AgentVoice-Challenge"))
            assertNull(upgrade.getHeader("Authorization"))
            assertEquals(SUBPROTOCOL, upgrade.getHeader("Sec-WebSocket-Protocol"))
            val signature = decodeBase64Url(upgrade.getHeader("X-AgentVoice-Signature")!!, 80)
            assertTrue(Signature.getInstance("SHA256withECDSA").run {
                initVerify(pair.public)
                update(deviceAuthSigningBytes(device, parseDeviceChallenge(
                    """{"v":1,"challengeId":"$challengeId","nonce":"$nonce","expiresAt":31000,"serverTime":1000}""")))
                verify(signature)
            })
        } finally {
            transport.cancel()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
            server.shutdown()
        }
    }

    @Test fun cancellationDuringDelayedChallengeCannotOpenAWebSocketOrRetry() {
        val fixture = fixture()
        fixture.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val events = Events()
        val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
        try {
            assertEquals("/v2/auth/challenge",
                fixture.server.takeRequest(3, TimeUnit.SECONDS)!!.path)
            transport.cancel()
            assertNull(events.queue.poll(200, TimeUnit.MILLISECONDS))
            assertEquals(1, fixture.server.requestCount)
            assertTrue(!transport.send("must not send"))
        } finally {
            transport.cancel()
            close(fixture)
        }
    }

    @Test fun challengeRedirectIsRejectedWithoutFollowingOrOpeningAWebSocket() {
        val fixture = fixture()
        fixture.server.enqueue(MockResponse().setResponseCode(302)
            .setHeader("Location", fixture.server.url("/redirected")))
        val events = Events()
        val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
        try {
            assertTrue(events.take().startsWith("Could not authenticate saved device access"))
            assertEquals(1, fixture.server.requestCount)
            assertTrue(!transport.send("must not send"))
        } finally {
            transport.cancel()
            close(fixture)
        }
    }

    @Test fun malformedChallengeFailsClosedBeforeKeyAccessOrUpgrade() {
        val fixture = fixture()
        fixture.server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"v":1,"challengeId":"AQIDBAUGBwgJCgsMDQ4PEA","nonce":"short","expiresAt":31000,"serverTime":1000}"""))
        val events = Events()
        val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
        try {
            assertTrue(events.take().startsWith("Could not open saved device access"))
            assertEquals(1, fixture.server.requestCount)
            assertTrue(!transport.send("must not send"))
        } finally {
            transport.cancel()
            close(fixture)
        }
    }

    @Test fun oversizedChallengeErrorBodyFailsGenericallyWithoutRetry() {
        val fixture = fixture()
        fixture.server.enqueue(MockResponse().setResponseCode(503)
            .setHeader("X-AgentVoice-Error", "pairing_unavailable")
            .setBody("x".repeat(32_000)))
        val events = Events()
        val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
        try {
            assertEquals("Could not authenticate saved device access. Update the app and server.",
                events.take())
            assertEquals(1, fixture.server.requestCount)
            assertTrue(!transport.send("must not send"))
        } finally {
            transport.cancel()
            close(fixture)
        }
    }

    @Test fun exactChallengeErrorBodiesAndHeadersSelectKnownFailures() {
        for ((status, code, expected) in listOf(
            Triple(400, "invalid_request", "Server protocol mismatch. Update the app and server."),
            Triple(404, "device_unavailable",
                "This phone’s device access was removed. Ask the server owner to pair it again."),
            Triple(429, "challenge_limited", "Server is busy. Try again when it is available."),
            Triple(503, "pairing_unavailable", "Server is unavailable. Start again when it is ready."),
        )) {
            val fixture = fixture()
            fixture.server.enqueue(MockResponse().setResponseCode(status)
                .setHeader("X-AgentVoice-Error", code)
                .setBody("""{"v":1,"error":{"code":"$code"}}"""))
            val events = Events()
            val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
            try {
                assertEquals(expected, events.take())
                assertEquals(1, fixture.server.requestCount)
            } finally {
                transport.cancel()
                close(fixture)
            }
        }
    }

    @Test fun headerFreeNotFoundRetainsOldServerConfigurationFailure() {
        val fixture = fixture()
        fixture.server.enqueue(MockResponse().setResponseCode(404))
        val events = Events()
        val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
        try {
            assertEquals("Server configuration mismatch. Update AgentVoice on your desktop.", events.take())
            assertEquals(1, fixture.server.requestCount)
        } finally {
            transport.cancel()
            close(fixture)
        }
    }

    @Test fun mismatchedOrMalformedChallengeErrorJsonFailsGenerically() {
        for (body in listOf(
            """{"v":1,"error":{"code":"invalid_request"}}""",
            """{"v":1,"error":{"code":"device_unavailable"},"extra":true}""",
            "not-json",
        )) {
            val fixture = fixture()
            fixture.server.enqueue(MockResponse().setResponseCode(404)
                .setHeader("X-AgentVoice-Error", "device_unavailable")
                .setBody(body))
            val events = Events()
            val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
            try {
                assertEquals("Could not authenticate saved device access. Update the app and server.",
                    events.take())
                assertEquals(1, fixture.server.requestCount)
            } finally {
                transport.cancel()
                close(fixture)
            }
        }
    }

    @Test fun malformedOrMismatchedChallengeErrorHeaderFailsGenerically() {
        for (header in listOf("device_auth_failed", "X".repeat(65), "unknown_error")) {
            val fixture = fixture()
            fixture.server.enqueue(MockResponse().setResponseCode(404)
                .setHeader("X-AgentVoice-Error", header))
            val events = Events()
            val transport = SecureTransport(fixture.client, device(fixture.server), events, unopenedKeys)
            try {
                assertTrue(events.take().startsWith("Could not authenticate saved device access"))
                assertEquals(1, fixture.server.requestCount)
            } finally {
                transport.cancel()
                close(fixture)
            }
        }
    }

    @Test fun signedWebSocketUsesOnlyExactBoundedFailureTuples() {
        val challenge = """{"v":1,"challengeId":"AQIDBAUGBwgJCgsMDQ4PEA","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","expiresAt":31000,"serverTime":1000}"""
        for ((header, expected) in listOf(
            "device_revoked" to "This phone’s device access was revoked. Ask the server owner to pair it again.",
            "device_auth_failed" to "Could not authenticate saved device access. Update the app and server.",
        )) {
            val fixture = fixture()
            fixture.server.enqueue(MockResponse().setResponseCode(200).setBody(challenge))
            fixture.server.enqueue(MockResponse().setResponseCode(403)
                .setHeader("X-AgentVoice-Error", header))
            val events = Events()
            val transport = SecureTransport(fixture.client, device(fixture.server), events, signingKeys())
            try {
                assertEquals(expected, events.take())
                assertEquals(2, fixture.server.requestCount)
            } finally {
                transport.cancel()
                close(fixture)
            }
        }
    }
}
