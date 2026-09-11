package com.arthack.agentvoice

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyStore
import java.security.Signature
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingStateStoreTest {
    private val fixtureId = UUID.randomUUID().toString()
    private val stateAlias = "agentvoice.test.pairing-state.$fixtureId"
    private val signingAlias = "agentvoice.test.device-auth.$fixtureId"
    private val directory = File(
        InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir,
        "pairing-store-test-$fixtureId",
    ).also { check(it.mkdirs()) }
    private val enrollment = "${"a".repeat(32)}.${"b".repeat(64)}"

    @After fun cleanOwnedFixtures() {
        directory.deleteRecursively()
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        for (alias in listOf(stateAlias, signingAlias)) {
            if (keys.containsAlias(alias)) keys.deleteEntry(alias)
        }
    }

    @Test fun encryptedPendingRoundTripsCompletesAndKeepsSigningKeyNonexportable() {
        val provider = AndroidDeviceKeyProvider()
        val key = provider.create(signingAlias)
        val qr = PairingQr.parse(PAIRING_QR_PREFIX +
            """{"v":1,"endpoint":"wss://voice.example:48414/v2/client","enrollment":"$enrollment","expiresAt":1800000300000}""")
        val pending = PendingPairing(qr, "01234567-89ab-4def-8123-456789abcdef",
            "Phone", signingAlias, encodeBase64Url(key.publicKey))
        val storage = EncryptedPairingStateStorage(
            InstrumentationRegistry.getInstrumentation().targetContext, directory, stateAlias)
        storage.saveNew(pending)

        val encrypted = File(directory, "device-pairing.v1").readBytes()
        assertTrue(encrypted.isNotEmpty())
        assertFalse(encrypted.containsSequence(enrollment.toByteArray()))
        assertFalse(encrypted.containsSequence(pending.requestId.toByteArray()))
        val loadedPending = EncryptedPairingStateStorage(
            InstrumentationRegistry.getInstrumentation().targetContext,
            directory, stateAlias).load() as PairingStoredState.Pending
        assertTrue(loadedPending.value.sameRequest(pending))
        assertThrows(IllegalStateException::class.java) { storage.saveNew(pending) }

        val paired = storage.complete(pending, PairingResult("c".repeat(32),
            "12345678-9abc-4def-8123-456789abcdef"))
        val ready = storage.load() as PairingStoredState.Ready
        assertEquals(paired.endpoint, ready.value.endpoint)
        assertEquals(paired.alias, ready.value.alias)
        assertEquals(paired.deviceId, ready.value.deviceId)
        assertEquals(paired.serverId, ready.value.serverId)
        val androidKeys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertNull(androidKeys.getKey(signingAlias, null).encoded)
        val bytes = "proof".toByteArray()
        assertTrue(Signature.getInstance("SHA256withECDSA").run {
            initVerify(androidKeys.getCertificate(signingAlias).publicKey)
            update(bytes)
            verify(provider.open(signingAlias).sign(bytes))
        })
    }

    @Test fun missingEncryptionKeyFailsWithoutCreatingAReplacement() {
        val provider = AndroidDeviceKeyProvider()
        val key = provider.create(signingAlias)
        val qr = PairingQr.parse(PAIRING_QR_PREFIX +
            """{"v":1,"endpoint":"wss://voice.example/v2/client","enrollment":"$enrollment","expiresAt":1800000300000}""")
        val pending = PendingPairing(qr, "01234567-89ab-4def-8123-456789abcdef",
            "Phone", signingAlias, encodeBase64Url(key.publicKey))
        val storage = EncryptedPairingStateStorage(
            InstrumentationRegistry.getInstrumentation().targetContext, directory, stateAlias)
        storage.saveNew(pending)
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        keys.deleteEntry(stateAlias)

        assertThrows(IllegalStateException::class.java) { storage.load() }
        val reopened = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(reopened.containsAlias(stateAlias))
        assertTrue(File(directory, "device-pairing.v1").isFile)
    }

    private fun ByteArray.containsSequence(sequence: ByteArray): Boolean {
        if (sequence.isEmpty()) return true
        for (start in 0..size - sequence.size) {
            var matches = true
            for (offset in sequence.indices) {
                if (this[start + offset] != sequence[offset]) {
                    matches = false
                    break
                }
            }
            if (matches) return true
        }
        return false
    }
}
