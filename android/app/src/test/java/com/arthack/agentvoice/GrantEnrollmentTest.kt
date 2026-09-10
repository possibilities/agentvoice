package com.arthack.agentvoice

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GrantEnrollmentTest {
    private val token = "${"a".repeat(32)}.${"b".repeat(64)}"

    private fun grantJson(endpoint: String = "wss://example.test/v2/client", version: Int = 1) =
        """{"version":$version,"endpoint":"$endpoint","token":"$token"}"""

    private fun grant(server: MockWebServer) = DeviceGrant.parse(grantJson(
        server.url("/v2/client").toString().replaceFirst("https:", "wss:")))

    private data class TlsFixture(
        val server: MockWebServer,
        val client: OkHttpClient,
    )

    private fun tlsFixture(): TlsFixture {
        val certificate = HeldCertificate.Builder()
            .commonName("localhost")
            .addSubjectAlternativeName("localhost")
            .build()
        val serverCertificates = HandshakeCertificates.Builder()
            .heldCertificate(certificate)
            .build()
        val clientCertificates = HandshakeCertificates.Builder()
            .addTrustedCertificate(certificate.certificate)
            .build()
        val server = MockWebServer().apply {
            useHttps(serverCertificates.sslSocketFactory(), false)
            start()
        }
        val client = secureHttpClient().newBuilder()
            .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager)
            .build()
        return TlsFixture(server, client)
    }

    private fun close(fixture: TlsFixture) {
        fixture.client.connectionPool.evictAll()
        fixture.client.dispatcher.executorService.shutdown()
        fixture.server.shutdown()
    }

    private fun awaitNoCalls(client: OkHttpClient) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        while (client.dispatcher.runningCallsCount() != 0 && System.nanoTime() < deadline) {
            Thread.sleep(10)
        }
        assertEquals(0, client.dispatcher.runningCallsCount())
    }

    private fun assertProblem(expected: GrantCheckProblem, responseCode: Int) {
        val fixture = tlsFixture()
        fixture.server.enqueue(MockResponse().setResponseCode(responseCode))
        try {
            val failure = assertThrows(GrantCheckFailure::class.java) {
                runBlocking { verifyGrant(fixture.client, grant(fixture.server), 2_000) }
            }
            assertEquals(expected, failure.problem)
            assertEquals(1, fixture.server.requestCount)
            awaitNoCalls(fixture.client)
        } finally {
            close(fixture)
        }
    }

    @Test fun qrRequiresTheExactOwnedPrefixAndGrantVersion() {
        val json = grantJson()
        val parsed = parseGrantQr(GRANT_QR_PREFIX + json)
        assertEquals("wss://example.test/v2/client", parsed.endpoint)
        assertEquals(token, parsed.token)

        for (foreign in listOf(
            json,
            " $GRANT_QR_PREFIX$json",
            "agentvoice-grant:v2:$json",
            "https://example.test/$json",
        )) {
            assertThrows(ProtocolFailure::class.java) { parseGrantQr(foreign) }
        }
        assertThrows(ProtocolFailure::class.java) {
            parseGrantQr(GRANT_QR_PREFIX + grantJson(version = 2))
        }
    }

    @Test fun qrBoundsTheCompleteUtf8Payload() {
        val base = GRANT_QR_PREFIX + grantJson()
        val atLimit = base + " ".repeat(MAX_GRANT_QR_BYTES - base.toByteArray(Charsets.UTF_8).size)
        assertEquals(MAX_GRANT_QR_BYTES, atLimit.toByteArray(Charsets.UTF_8).size)
        assertEquals(token, parseGrantQr(atLimit).token)
        assertThrows(ProtocolFailure::class.java) { parseGrantQr("$atLimit ") }

        val multibyte = GRANT_QR_PREFIX + "é".repeat(MAX_GRANT_QR_BYTES / 2)
        assertTrue(multibyte.length <= MAX_GRANT_QR_BYTES)
        assertTrue(multibyte.toByteArray(Charsets.UTF_8).size > MAX_GRANT_QR_BYTES)
        assertThrows(ProtocolFailure::class.java) { parseGrantQr(multibyte) }
    }

    @Test fun verificationUsesTrustedTlsAndOnlyAuthenticatesTheUpgrade() {
        val fixture = tlsFixture()
        val receivedFrames = LinkedBlockingQueue<String>()
        fixture.server.enqueue(MockResponse()
            .setHeader("Sec-WebSocket-Protocol", SUBPROTOCOL)
            .withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    receivedFrames.add(text)
                }
            }))
        try {
            runBlocking { verifyGrant(fixture.client, grant(fixture.server), 2_000) }
            val request = fixture.server.takeRequest(2, TimeUnit.SECONDS)
            assertNotNull(request)
            assertEquals("Bearer $token", request!!.getHeader("Authorization"))
            assertEquals(SUBPROTOCOL, request.getHeader("Sec-WebSocket-Protocol"))
            assertNull(request.getHeader("Origin"))
            assertNull(receivedFrames.poll(150, TimeUnit.MILLISECONDS))
            awaitNoCalls(fixture.client)
        } finally {
            close(fixture)
        }
    }

    @Test fun verificationClassifiesRejectedBusyAndHttpProtocolFailures() {
        for (code in listOf(401, 403)) assertProblem(GrantCheckProblem.Rejected, code)
        assertProblem(GrantCheckProblem.Busy, 429)
        for (code in listOf(404, 421, 426)) assertProblem(GrantCheckProblem.Protocol, code)
    }

    @Test fun verificationRejectsAnUnselectedSubprotocol() {
        val fixture = tlsFixture()
        fixture.server.enqueue(MockResponse()
            .setHeader("Sec-WebSocket-Protocol", "foreign.v1")
            .withWebSocketUpgrade(object : WebSocketListener() {}))
        try {
            val failure = assertThrows(GrantCheckFailure::class.java) {
                runBlocking { verifyGrant(fixture.client, grant(fixture.server), 2_000) }
            }
            assertEquals(GrantCheckProblem.Protocol, failure.problem)
            awaitNoCalls(fixture.client)
        } finally {
            close(fixture)
        }
    }

    @Test fun timeoutCancelsThePendingUpgrade() {
        val fixture = tlsFixture()
        fixture.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        try {
            assertThrows(TimeoutCancellationException::class.java) {
                runBlocking { verifyGrant(fixture.client, grant(fixture.server), 100) }
            }
            assertEquals(1, fixture.server.requestCount)
            awaitNoCalls(fixture.client)
        } finally {
            close(fixture)
        }
    }

    @Test fun callerCancellationCancelsThePendingUpgrade() = runBlocking {
        val fixture = tlsFixture()
        fixture.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        try {
            val verification = launch(start = CoroutineStart.UNDISPATCHED) {
                verifyGrant(fixture.client, grant(fixture.server), 5_000)
            }
            assertNotNull(fixture.server.takeRequest(2, TimeUnit.SECONDS))
            verification.cancelAndJoin()
            assertTrue(verification.isCancelled)
            awaitNoCalls(fixture.client)
        } finally {
            close(fixture)
        }
    }

    @Test fun foregroundPolicyWaitsForLoadAndAttemptsOnlyOncePerVisit() {
        val policy = ForegroundConnectionPolicy()
        assertFalse(policy.claim(loaded = true, hasGrant = true, resumed = true, running = false))

        policy.enter()
        assertFalse(policy.claim(loaded = false, hasGrant = true, resumed = true, running = false))
        assertFalse(policy.claim(loaded = true, hasGrant = false, resumed = true, running = false))
        assertFalse(policy.claim(loaded = true, hasGrant = true, resumed = false, running = false))
        assertTrue(policy.claim(loaded = true, hasGrant = true, resumed = true, running = false))
        assertFalse(policy.claim(loaded = true, hasGrant = true, resumed = true, running = false))

        policy.leave()
        assertFalse(policy.claim(loaded = true, hasGrant = true, resumed = true, running = false))
        policy.enter()
        assertFalse(policy.claim(loaded = true, hasGrant = true, resumed = true, running = true))
        assertTrue(policy.claim(loaded = true, hasGrant = true, resumed = true, running = false))
    }
}
