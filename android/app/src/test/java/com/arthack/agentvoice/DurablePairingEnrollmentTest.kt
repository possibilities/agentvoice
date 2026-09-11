package com.arthack.agentvoice

import java.security.KeyPairGenerator
import java.security.Signature
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DurablePairingEnrollmentTest {
    private class MemoryStates : PairingStateStorage {
        var state: PairingStoredState? = null
        override fun load() = state
        override fun saveNew(value: PendingPairing) {
            check(state == null)
            state = PairingStoredState.Pending(value)
        }
        override fun complete(expected: PendingPairing, result: PairingResult): PairedDevice {
            check((state as? PairingStoredState.Pending)?.value?.sameRequest(expected) == true)
            return PairedDevice(expected.qr.endpoint, expected.alias, result.deviceId, result.serverId)
                .also { state = PairingStoredState.Ready(it) }
        }
    }

    private class FakeKeys : DeviceKeyProvider {
        var creates = 0
        val keys = mutableMapOf<String, DeviceSigningKey>()
        override fun create(alias: String): DeviceSigningKey {
            creates++
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
            return object : DeviceSigningKey {
                override val alias = alias
                override val publicKey = pair.public.encoded
                override fun sign(value: ByteArray) = Signature.getInstance("SHA256withECDSA").run {
                    initSign(pair.private); update(value); sign()
                }
            }.also { keys[alias] = it }
        }
        override fun open(alias: String) = keys[alias]
            ?: throw IllegalStateException("Saved device signing key is unavailable")
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

    private fun qr(server: MockWebServer, expiresAt: Long = 20_000) = PAIRING_QR_PREFIX +
        """{"v":1,"endpoint":"${server.url("/v2/client").toString().replaceFirst("https:", "wss:")}","enrollment":"${"a".repeat(32)}.${"b".repeat(64)}","expiresAt":$expiresAt}"""

    private fun result() =
        """{"v":1,"deviceId":"${"c".repeat(32)}","serverId":"01234567-89ab-4def-8123-456789abcdef"}"""

    @Test fun freshEnrollmentPersistsBeforeOneExactPostAndAcceptsCreatedResponse() {
        val fixture = fixture()
        val states = MemoryStates()
        val keys = FakeKeys()
        val store = DeviceCredentialStore({ null }, states, keys)
        val enrollment = PairingEnrollment(fixture.client, store) { 10_000 }
        fixture.server.enqueue(MockResponse().setResponseCode(201).setBody(result()))
        try {
            val paired = runBlocking { enrollment.enrollPairing(qr(fixture.server), "e\u0301 phone") }
            assertEquals("c".repeat(32), paired.deviceId)
            assertEquals(1, keys.creates)
            assertTrue(states.state is PairingStoredState.Ready)
            val request = fixture.server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/v2/pair", request.path)
            val body = jsonObject(request.body.readUtf8())
            body.fields("v", "enrollment", "requestId", "label", "publicKey")
            body.version(1)
            assertEquals("é phone", body.string("label"))
            assertEquals("${"a".repeat(32)}.${"b".repeat(64)}", body.string("enrollment"))
            assertEquals(1, fixture.server.requestCount)
        } finally {
            fixture.client.connectionPool.evictAll()
            fixture.client.dispatcher.executorService.shutdown()
            fixture.server.shutdown()
        }
    }

    @Test fun uncertainResponseKeepsExactTupleAndExplicitRetryRecoversIt() {
        val fixture = fixture()
        val states = MemoryStates()
        val keys = FakeKeys()
        val store = DeviceCredentialStore({ null }, states, keys)
        val enrollment = PairingEnrollment(fixture.client, store) { 10_000 }
        fixture.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        fixture.server.enqueue(MockResponse().setResponseCode(200).setBody(result()))
        try {
            val failure = assertThrows(PairingFailure::class.java) {
                runBlocking { enrollment.enrollPairing(qr(fixture.server), "e\u0301 phone") }
            }
            assertEquals(PairingProblem.Unreachable, failure.problem)
            val pending = (states.state as PairingStoredState.Pending).value
            assertEquals("é phone", pending.label)
            assertEquals(1, keys.creates)

            val paired = runBlocking { enrollment.retryPairing() }
            assertEquals("c".repeat(32), paired.deviceId)
            assertEquals(1, keys.creates)
            val first = fixture.server.takeRequest(2, TimeUnit.SECONDS)!!
            val second = fixture.server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/v2/pair", first.path)
            assertEquals(first.body.readUtf8(), second.body.readUtf8())
            assertTrue(store.load() is StoredCredential.Ready)
        } finally {
            fixture.client.connectionPool.evictAll()
            fixture.client.dispatcher.executorService.shutdown()
            fixture.server.shutdown()
        }
    }

    @Test fun pairingFailureRequiresMatchingBoundedHeaderAndBodyCode() {
        for ((header, expected) in listOf(
            "device_unavailable" to PairingProblem.DeviceUnavailable,
            "enrollment_consumed" to PairingProblem.Protocol,
            "X".repeat(65) to PairingProblem.Protocol,
        )) {
            val fixture = fixture()
            val states = MemoryStates()
            val keys = FakeKeys()
            val enrollment = PairingEnrollment(fixture.client,
                DeviceCredentialStore({ null }, states, keys)) { 10_000 }
            fixture.server.enqueue(MockResponse().setResponseCode(409)
                .setHeader("X-AgentVoice-Error", header)
                .setBody("""{"v":1,"error":{"code":"device_unavailable"}}"""))
            try {
                val failure = assertThrows(PairingFailure::class.java) {
                    runBlocking { enrollment.enrollPairing(qr(fixture.server), "phone") }
                }
                assertEquals(expected, failure.problem)
                assertTrue(states.state is PairingStoredState.Pending)
                assertEquals(1, fixture.server.requestCount)
            } finally {
                fixture.client.connectionPool.evictAll()
                fixture.client.dispatcher.executorService.shutdown()
                fixture.server.shutdown()
            }
        }
    }

    @Test fun expiredFreshQrDoesNotCreateStateKeyOrNetworkRequest() {
        val fixture = fixture()
        val states = MemoryStates()
        val keys = FakeKeys()
        val enrollment = PairingEnrollment(fixture.client,
            DeviceCredentialStore({ null }, states, keys)) { 20_000 }
        try {
            val failure = assertThrows(PairingFailure::class.java) {
                runBlocking { enrollment.enrollPairing(qr(fixture.server, 20_000), "phone") }
            }
            assertEquals(PairingProblem.ExpiredQr, failure.problem)
            assertEquals(null, states.state)
            assertEquals(0, keys.creates)
            assertEquals(0, fixture.server.requestCount)
        } finally {
            fixture.client.connectionPool.evictAll()
            fixture.client.dispatcher.executorService.shutdown()
            fixture.server.shutdown()
        }
    }

    @Test fun missingStoredKeyFailsWithoutGeneratingAReplacement() {
        val fixture = fixture()
        val states = MemoryStates()
        val keys = FakeKeys()
        val store = DeviceCredentialStore({ null }, states, keys)
        val parsed = PairingQr.parse(qr(fixture.server))
        val pending = store.prepare(parsed, "phone")
        keys.keys.remove(pending.alias)
        try {
            assertThrows(IllegalStateException::class.java) { store.load() }
            assertThrows(IllegalStateException::class.java) { store.pendingForRetry() }
            assertEquals(1, keys.creates)
            assertTrue(states.state is PairingStoredState.Pending)
        } finally {
            fixture.client.connectionPool.evictAll()
            fixture.client.dispatcher.executorService.shutdown()
            fixture.server.shutdown()
        }
    }

    @Test fun aLegacyCredentialPreventsPreparingPairing() {
        val fixture = fixture()
        val states = MemoryStates()
        val keys = FakeKeys()
        val token = "${"d".repeat(32)}.${"e".repeat(64)}"
        val legacy = DeviceGrant.parse(
            """{"version":1,"endpoint":"wss://voice.example/v2/client","token":"$token"}""")
        val store = DeviceCredentialStore({ legacy }, states, keys)
        try {
            assertTrue((store.load() as StoredCredential.Ready).credential === legacy)
            assertThrows(IllegalStateException::class.java) {
                store.prepare(PairingQr.parse(qr(fixture.server)), "phone")
            }
            assertEquals(0, keys.creates)
            assertEquals(null, states.state)
        } finally {
            fixture.client.connectionPool.evictAll()
            fixture.client.dispatcher.executorService.shutdown()
            fixture.server.shutdown()
        }
    }

    @Test fun legacyAndPairingStateTogetherFailClosed() {
        val fixture = fixture()
        val states = MemoryStates()
        val keys = FakeKeys()
        val token = "${"d".repeat(32)}.${"e".repeat(64)}"
        val legacy = DeviceGrant.parse(
            """{"version":1,"endpoint":"wss://voice.example/v2/client","token":"$token"}""")
        val firstStore = DeviceCredentialStore({ null }, states, keys)
        firstStore.prepare(PairingQr.parse(qr(fixture.server)), "phone")
        val conflicted = DeviceCredentialStore({ legacy }, states, keys)
        try {
            assertThrows(IllegalStateException::class.java) { conflicted.load() }
            assertEquals(1, keys.creates)
            assertTrue(states.state is PairingStoredState.Pending)
        } finally {
            fixture.client.connectionPool.evictAll()
            fixture.client.dispatcher.executorService.shutdown()
            fixture.server.shutdown()
        }
    }
}
