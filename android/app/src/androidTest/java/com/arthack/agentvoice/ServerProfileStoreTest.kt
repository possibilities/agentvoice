package com.arthack.agentvoice

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyStore
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerProfileStoreTest {
    private val fixtureId = UUID.randomUUID().toString()
    private val collectionAlias = "agentvoice.test.server-profiles.$fixtureId"
    private val grantAlias = "agentvoice.test.legacy-grant.$fixtureId"
    private val pairingAlias = "agentvoice.test.legacy-pairing.$fixtureId"
    private val signingAlias = "agentvoice.test.device-auth.$fixtureId"
    private val directory = File(
        InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir,
        "server-profile-store-test-$fixtureId",
    ).also { check(it.mkdirs()) }
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val token = "${"a".repeat(32)}.${"b".repeat(64)}"
    private val enrollment = "${"c".repeat(32)}.${"d".repeat(64)}"

    @After fun cleanOwnedFixtures() {
        directory.deleteRecursively()
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        for (alias in listOf(collectionAlias, grantAlias, pairingAlias, signingAlias)) {
            if (keys.containsAlias(alias)) keys.deleteEntry(alias)
        }
    }

    @Test fun migrationEncryptsCollectionPreservesSourcesAndEmptyMarkerPreventsReimport() {
        val grantStore = GrantStore(context, directory, grantAlias)
        grantStore.saveNew(DeviceGrant.parse(
            """{"version":1,"endpoint":"wss://one.example/v2/client","token":"$token"}""",
        ))
        val signingKey = AndroidDeviceKeyProvider().create(signingAlias)
        val pending = PendingPairing(
            PairingQr.parse(PAIRING_QR_PREFIX +
                """{"v":1,"endpoint":"wss://two.example/v2/client","enrollment":"$enrollment","expiresAt":1800000300000}"""),
            "01234567-89ab-4def-8123-456789abcdef",
            "Phone",
            signingAlias,
            encodeBase64Url(signingKey.publicKey),
        )
        val pairingStore = EncryptedPairingStateStorage(context, directory, pairingAlias)
        pairingStore.saveNew(pending)
        val grantBytes = File(directory, "device-grant.v1").readBytes()
        val pairingBytes = File(directory, "device-pairing.v1").readBytes()
        val collectionStorage = EncryptedServerProfileStorage(context, directory, collectionAlias)
        val credentials = DeviceCredentialStore(
            collectionStorage,
            grantStore::load,
            pairingStore::load,
            AndroidDeviceKeyProvider(),
        )

        val migrated = credentials.listProfiles()
        assertEquals(2, migrated.profiles.size)
        val encrypted = File(directory, "device-server-profiles.v1").readBytes()
        assertFalse(encrypted.containsSequence(token.toByteArray()))
        assertFalse(encrypted.containsSequence(enrollment.toByteArray()))
        assertArrayEquals(grantBytes, File(directory, "device-grant.v1").readBytes())
        assertArrayEquals(pairingBytes, File(directory, "device-pairing.v1").readBytes())

        migrated.profiles.forEach { credentials.forget(it.id) }
        var legacyReads = 0
        val reopened = DeviceCredentialStore(
            EncryptedServerProfileStorage(context, directory, collectionAlias),
            { legacyReads++; grantStore.load() },
            { legacyReads++; pairingStore.load() },
            AndroidDeviceKeyProvider(),
        )
        assertTrue(reopened.listProfiles().profiles.isEmpty())
        assertEquals(0, legacyReads)
        assertTrue(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            .containsAlias(signingAlias))
    }

    @Test fun missingCollectionKeyFailsWithoutFallbackOrFileMutation() {
        val storage = EncryptedServerProfileStorage(context, directory, collectionAlias)
        val credentials = DeviceCredentialStore(
            storage,
            { DeviceGrant.parse(
                """{"version":1,"endpoint":"wss://one.example/v2/client","token":"$token"}""",
            ) },
            { null },
            AndroidDeviceKeyProvider(),
        )
        credentials.listProfiles()
        val file = File(directory, "device-server-profiles.v1")
        val original = file.readBytes()
        KeyStore.getInstance("AndroidKeyStore").apply {
            load(null)
            deleteEntry(collectionAlias)
        }
        var legacyReads = 0
        val reopened = DeviceCredentialStore(
            EncryptedServerProfileStorage(context, directory, collectionAlias),
            { legacyReads++; null },
            { legacyReads++; null },
            AndroidDeviceKeyProvider(),
        )

        assertThrows(IllegalStateException::class.java) { reopened.listProfiles() }
        assertEquals(0, legacyReads)
        assertArrayEquals(original, file.readBytes())
        assertFalse(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            .containsAlias(collectionAlias))
    }

    @Test fun tamperedCollectionFailsWithoutLegacyFallbackAndRetainsCiphertext() {
        val storage = EncryptedServerProfileStorage(context, directory, collectionAlias)
        DeviceCredentialStore(storage, { null }, { null }, AndroidDeviceKeyProvider()).listProfiles()
        val file = File(directory, "device-server-profiles.v1")
        val malformed = file.readBytes().also {
            it[it.lastIndex] = (it.last().toInt() xor 1).toByte()
        }
        file.writeBytes(malformed)
        var legacyReads = 0
        val reopened = DeviceCredentialStore(
            EncryptedServerProfileStorage(context, directory, collectionAlias),
            { legacyReads++; null },
            { legacyReads++; null },
            AndroidDeviceKeyProvider(),
        )

        assertThrows(Exception::class.java) { reopened.listProfiles() }
        assertEquals(0, legacyReads)
        assertArrayEquals(malformed, file.readBytes())
    }

    @Test fun encryptedCollectionRoundTripsReadyProfilesWithoutSelection() {
        val storage = EncryptedServerProfileStorage(context, directory, collectionAlias)
        val id = "11111111-1111-4111-8111-111111111111"
        val readyWithoutSelection = StoredServerProfiles(null, listOf(StoredServerProfile(
            id,
            StoredProfileValue.Ready(DeviceGrant.parse(
                """{"version":1,"endpoint":"wss://one.example/v2/client","token":"$token"}""",
            )),
        )))
        storage.update({ StoredServerProfiles(null, emptyList()) }) { readyWithoutSelection }

        val reopened = EncryptedServerProfileStorage(context, directory, collectionAlias)
            .loadOrCreate { throw AssertionError("Collection should already exist") }
        assertEquals(null, reopened.selectedId)
        assertEquals(id, reopened.profiles.single().id)
        assertTrue(reopened.profiles.single().value is StoredProfileValue.Ready)
    }

    private fun ByteArray.containsSequence(sequence: ByteArray): Boolean {
        if (sequence.isEmpty()) return true
        for (start in 0..size - sequence.size) {
            if (sequence.indices.all { offset -> this[start + offset] == sequence[offset] }) {
                return true
            }
        }
        return false
    }
}
