package com.arthack.agentvoice

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString.Companion.encodeUtf8
import org.junit.Assert.*
import org.junit.Test

class SecureTransportTest {
    private class Events : TransportEvents {
        val queue = LinkedBlockingQueue<String>()
        override fun opened() { queue.add("open") }
        override fun text(value: String, consumed: () -> Unit) { queue.add(value); consumed() }
        override fun ended(message: String) { queue.add(message) }
        fun take(): String = queue.poll(5, TimeUnit.SECONDS) ?: error("Timed out")
    }
    private fun grant(server: MockWebServer) = DeviceGrant.parse("""{"version":1,"endpoint":"${server.url("/v2/client").toString().replace("https:", "wss:")}","token":"${"a".repeat(32)}.${"b".repeat(64)}"}""")
    private fun server(certificate: HeldCertificate) = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
        start()
    }
    private fun trusted(certificate: HeldCertificate): OkHttpClient {
        val certificates = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        return secureHttpClient().newBuilder().sslSocketFactory(certificates.sslSocketFactory(), certificates.trustManager).build()
    }
    private fun close(client: OkHttpClient) { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }

    @Test fun authenticatedUpgradeUsesExactProtocolAndNoOriginOrAutomaticCall() {
        val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val server = server(certificate)
        val client = trusted(certificate)
        val incoming = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().setHeader("Sec-WebSocket-Protocol", SUBPROTOCOL).withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) { incoming.add(text) }
        }))
        val events = Events()
        val transport = SecureTransport(client, grant(server), events)
        try {
            assertEquals("open", events.take())
            val request = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals(SUBPROTOCOL, request.getHeader("Sec-WebSocket-Protocol"))
            assertEquals("Bearer ${"a".repeat(32)}.${"b".repeat(64)}", request.getHeader("Authorization"))
            assertNull(request.getHeader("Origin"))
            assertNull(incoming.poll(100, TimeUnit.MILLISECONDS))
            assertTrue(transport.send("explicit test message"))
            assertEquals("explicit test message", incoming.poll(3, TimeUnit.SECONDS))
        } finally { transport.cancel(); close(client); server.shutdown() }
    }
    @Test fun defaultTrustRejectsUnknownCertificateBeforeAnyCall() {
        val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val server = server(certificate)
        val client = secureHttpClient()
        val events = Events()
        val transport = SecureTransport(client, grant(server), events)
        try {
            assertTrue(events.take().startsWith("Could not connect securely"))
            assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
            assertFalse(transport.send("must not send"))
        } finally { transport.cancel(); close(client); server.shutdown() }
    }
    @Test fun wrongSubprotocolAndBinaryFramesTerminate() {
        val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        for (binary in listOf(false, true)) {
            val server = server(certificate)
            val client = trusted(certificate)
            server.enqueue(MockResponse().setHeader("Sec-WebSocket-Protocol", if (binary) SUBPROTOCOL else "wrong")
                .withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        if (binary) webSocket.send("binary".encodeUtf8())
                    }
                }))
            val events = Events()
            val transport = SecureTransport(client, grant(server), events)
            try {
                if (binary) assertEquals("open", events.take())
                assertTrue(events.take().contains(if (binary) "Unexpected" else "mismatch"))
                assertFalse(transport.send("must not send"))
            } finally { transport.cancel(); close(client); server.shutdown() }
        }
    }
    @Test fun redirectsNeverForwardTheGrantOrRetry() {
        val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val server = server(certificate)
        val other = server(certificate)
        val client = trusted(certificate)
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", other.url("/v2/client")))
        val events = Events()
        val transport = SecureTransport(client, grant(server), events)
        try {
            assertTrue(events.take().startsWith("Could not connect securely"))
            assertEquals(1, server.requestCount)
            assertNull(other.takeRequest(100, TimeUnit.MILLISECONDS))
        } finally { transport.cancel(); close(client); server.shutdown(); other.shutdown() }
    }
}
