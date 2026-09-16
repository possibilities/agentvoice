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
    private class MemoryProfiles : ServerProfileStorage {
        var stored: StoredServerProfiles? = null

        override fun loadOrCreate(initial: () -> StoredServerProfiles): StoredServerProfiles =
            stored ?: initial().also { stored = it }

        override fun update(
            initial: () -> StoredServerProfiles,
            transform: (StoredServerProfiles) -> StoredServerProfiles,
        ): StoredServerProfiles = transform(stored ?: initial()).also { stored = it }
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
                    initSign(pair.private)
                    update(value)
                    sign()
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
        val clientCertificates = HandshakeCertificates.Builder()
            .addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply {
            useHttps(serverCertificates.sslSocketFactory(), false)
            start()
        }
        val client = secureHttpClient().newBuilder()
            .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager)
            .build()
        return Fixture(server, client)
    }

    private fun close(fixture: Fixture) {
        fixture.client.connectionPool.evictAll()
        fixture.client.dispatcher.executorService.shutdown()
        fixture.server.shutdown()
    }

    private fun store(
        profiles: MemoryProfiles,
        keys: FakeKeys,
        grant: () -> DeviceGrant? = { null },
        pairing: () -> PairingStoredState? = { null },
    ) = DeviceCredentialStore(profiles, grant, pairing, keys)

    private fun qr(server: MockWebServer, expiresAt: Long = 20_000) =
        qr(server.url("/v2/client").toString().replaceFirst("https:", "wss:"), expiresAt)

    private fun qr(endpoint: String, expiresAt: Long = 20_000) = PAIRING_QR_PREFIX +
        """{"v":1,"endpoint":"$endpoint","enrollment":"${"a".repeat(32)}.${"b".repeat(64)}","expiresAt":$expiresAt}"""

    private fun result(
        deviceId: String = "c".repeat(32),
        serverId: String = "01234567-89ab-4def-8123-456789abcdef",
    ) = """{"v":1,"deviceId":"$deviceId","serverId":"$serverId"}"""

    @Test fun freshEnrollmentPersistsBeforePostAndReturnsReadyUnselectedProfile() {
        val fixture = fixture()
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val enrollment = PairingEnrollment(fixture.client, store(profiles, keys)) { 10_000 }
        fixture.server.enqueue(MockResponse().setResponseCode(201).setBody(result()))
        try {
            val completed = runBlocking { enrollment.enrollPairing(qr(fixture.server), "e\u0301 phone") }
            assertEquals("c".repeat(32), completed.credential.deviceId)
            assertEquals(null, completed.profiles.selectedId)
            assertEquals(listOf("Server 1"), completed.profiles.profiles.map { it.name })
            assertEquals(ServerProfileState.READY, completed.profiles.profiles.single().state)
            assertEquals(1, keys.creates)
            val request = fixture.server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/v2/pair", request.path)
            val body = jsonObject(request.body.readUtf8())
            body.fields("v", "enrollment", "requestId", "label", "publicKey")
            assertEquals("é phone", body.string("label"))
            assertEquals(1, fixture.server.requestCount)
        } finally {
            close(fixture)
        }
    }

    @Test fun uncertainResponseKeepsExactTupleAndExplicitProfileRetryRecoversIt() {
        val fixture = fixture()
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val credentials = store(profiles, keys)
        val enrollment = PairingEnrollment(fixture.client, credentials) { 10_000 }
        fixture.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        fixture.server.enqueue(MockResponse().setResponseCode(200).setBody(result()))
        try {
            val failure = assertThrows(PairingFailure::class.java) {
                runBlocking { enrollment.enrollPairing(qr(fixture.server), "e\u0301 phone") }
            }
            assertEquals(PairingProblem.Unreachable, failure.problem)
            val pendingProfile = credentials.listProfiles().profiles.single()
            val pending = (profiles.stored!!.profiles.single().value as StoredProfileValue.Pending).pairing
            assertEquals("é phone", pending.label)

            val completed = runBlocking { enrollment.retryPairing(pendingProfile.id) }
            assertEquals(pendingProfile.id, completed.profileId)
            assertEquals(1, keys.creates)
            val first = fixture.server.takeRequest(2, TimeUnit.SECONDS)!!
            val second = fixture.server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals(first.body.readUtf8(), second.body.readUtf8())
            assertTrue(credentials.load() is StoredCredential.Empty)
            assertEquals(completed.credential.deviceId, (credentials.credential(completed.profileId) as PairedDevice).deviceId)
        } finally {
            close(fixture)
        }
    }

    @Test fun expiredQrCreatesNothingAndServerFailureRetainsPending() {
        val fixture = fixture()
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val credentials = store(profiles, keys)
        val enrollment = PairingEnrollment(fixture.client, credentials) { 20_000 }
        try {
            val expired = assertThrows(PairingFailure::class.java) {
                runBlocking { enrollment.enrollPairing(qr(fixture.server, 20_000), "phone") }
            }
            assertEquals(PairingProblem.ExpiredQr, expired.problem)
            assertEquals(null, profiles.stored)
            assertEquals(0, keys.creates)

            fixture.server.enqueue(MockResponse().setResponseCode(409)
                .setHeader("X-AgentVoice-Error", "device_unavailable")
                .setBody("""{"v":1,"error":{"code":"device_unavailable"}}"""))
            val failed = assertThrows(PairingFailure::class.java) {
                runBlocking { enrollment.enrollPairing(qr(fixture.server, 30_000), "phone") }
            }
            assertEquals(PairingProblem.DeviceUnavailable, failed.problem)
            assertEquals(ServerProfileState.PENDING, credentials.listProfiles().profiles.single().state)
        } finally {
            close(fixture)
        }
    }

    @Test fun missingPendingKeyDoesNotHideMetadataOrCreateReplacement() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val credentials = store(profiles, keys)
        val pending = credentials.prepare(PairingQr.parse(qr("wss://one.example/v2/client")), "phone")
        keys.keys.remove(pending.pairing.alias)

        assertEquals(ServerProfileState.PENDING, credentials.listProfiles().profiles.single().state)
        assertThrows(IllegalStateException::class.java) {
            credentials.pendingForRetry(pending.profileId)
        }
        assertEquals(1, keys.creates)
        assertTrue(profiles.stored!!.profiles.single().value is StoredProfileValue.Pending)
    }
}
