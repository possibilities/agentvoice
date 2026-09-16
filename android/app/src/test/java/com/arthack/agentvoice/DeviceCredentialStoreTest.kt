package com.arthack.agentvoice

import java.security.KeyPairGenerator
import java.security.Signature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCredentialStoreTest {
    private class MemoryProfiles : ServerProfileStorage {
        var stored: StoredServerProfiles? = null
        var initialCalls = 0

        override fun loadOrCreate(initial: () -> StoredServerProfiles): StoredServerProfiles =
            stored ?: initial().also { initialCalls++; stored = it }

        override fun update(
            initial: () -> StoredServerProfiles,
            transform: (StoredServerProfiles) -> StoredServerProfiles,
        ): StoredServerProfiles {
            val current = stored ?: initial().also { initialCalls++ }
            return transform(current).also { stored = it }
        }
    }

    private class FakeKeys : DeviceKeyProvider {
        var creates = 0
        val values = mutableMapOf<String, DeviceSigningKey>()

        override fun create(alias: String): DeviceSigningKey {
            creates++
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
            return object : DeviceSigningKey {
                override val alias = alias
                override val publicKey = pair.public.encoded
                override fun sign(value: ByteArray) = Signature.getInstance("SHA256withECDSA").run {
                    initSign(pair.private); update(value); sign()
                }
            }.also { values[alias] = it }
        }

        override fun open(alias: String) = values[alias]
            ?: throw IllegalStateException("Saved device signing key is unavailable")
    }

    private val enrollment = "${"a".repeat(32)}.${"b".repeat(64)}"
    private val token = "${"d".repeat(32)}.${"e".repeat(64)}"

    private fun grant(endpoint: String) = DeviceGrant.parse(
        """{"version":1,"endpoint":"$endpoint","token":"$token"}""",
    )

    private fun qr(endpoint: String) = PairingQr.parse(PAIRING_QR_PREFIX +
        """{"v":1,"endpoint":"$endpoint","enrollment":"$enrollment","expiresAt":20000}""")

    private fun store(
        profiles: MemoryProfiles,
        keys: FakeKeys,
        grant: () -> DeviceGrant? = { null },
        pairing: () -> PairingStoredState? = { null },
    ) = DeviceCredentialStore(profiles, grant, pairing, keys)

    @Test fun migrationRetainsDistinctLegacySourcesAndCollectionStaysAuthoritativeWhenEmpty() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        var grantLoads = 0
        var pairingLoads = 0
        val paired = PairedDevice(
            "wss://two.example/v2/client",
            "old-signing-key",
            "1".repeat(32),
            "01234567-89ab-4def-8123-456789abcdef",
        )
        val credentials = store(
            profiles,
            keys,
            grant = { grantLoads++; grant("wss://one.example/v2/client") },
            pairing = { pairingLoads++; PairingStoredState.Ready(paired) },
        )

        val migrated = credentials.listProfiles()
        assertEquals(2, migrated.profiles.size)
        assertEquals(migrated.profiles.first().id, migrated.selectedId)
        assertEquals(listOf("Server 1", "Server 2"), migrated.profiles.map { it.name })
        assertEquals(1, grantLoads)
        assertEquals(1, pairingLoads)

        credentials.forget(migrated.profiles.first().id)
        credentials.forget(migrated.profiles.last().id)
        assertTrue(credentials.listProfiles().profiles.isEmpty())
        assertEquals(1, grantLoads)
        assertEquals(1, pairingLoads)
        assertEquals(1, profiles.initialCalls)
    }

    @Test fun ambiguousSameEndpointMigrationFailsClosedWithoutCommittingCollection() {
        val profiles = MemoryProfiles()
        val ready = PairedDevice(
            "wss://same.example/v2/client",
            "old-signing-key",
            "1".repeat(32),
            "01234567-89ab-4def-8123-456789abcdef",
        )
        val credentials = store(
            profiles,
            FakeKeys(),
            grant = { grant("wss://SAME.example:443/v2/client") },
            pairing = { PairingStoredState.Ready(ready) },
        )

        assertThrows(ProtocolFailure::class.java) { credentials.listProfiles() }
        assertEquals(null, profiles.stored)
    }

    @Test fun pendingAndCompletionPreserveExistingReadySelection() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val credentials = store(
            profiles,
            keys,
            grant = { grant("wss://one.example/v2/client") },
        )
        val original = credentials.listProfiles()
        val pending = credentials.prepare(qr("wss://two.example/v2/client"), "phone")
        assertEquals(original.selectedId, credentials.listProfiles().selectedId)

        val completed = credentials.complete(
            pending.profileId,
            pending.pairing,
            PairingResult("2".repeat(32), "12345678-9abc-4def-8123-456789abcdef"),
        )
        assertEquals(pending.profileId, completed.profileId)
        assertEquals(original.selectedId, completed.profiles.selectedId)
        assertEquals(listOf("Server 1", "Server 2"), completed.profiles.profiles.map { it.name })
        assertEquals(original.selectedId, store(profiles, keys).listProfiles().selectedId)
    }

    @Test fun duplicateEndpointAndPendingLimitAreTypedAndNeverCreateExtraKeys() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val credentials = store(
            profiles,
            keys,
            grant = { grant("wss://ONE.example:443/v2/client") },
        )
        credentials.listProfiles()
        val duplicate = assertThrows(ProfileStoreFailure::class.java) {
            credentials.prepare(qr("wss://one.example/v2/client"), "phone")
        }
        assertEquals(ProfileStoreProblem.DuplicateEndpoint, duplicate.problem)
        assertEquals(0, keys.creates)

        credentials.prepare(qr("wss://two.example/v2/client"), "phone")
        val alreadyPending = assertThrows(ProfileStoreFailure::class.java) {
            credentials.prepare(qr("wss://three.example/v2/client"), "phone")
        }
        assertEquals(ProfileStoreProblem.PairingAlreadyPending, alreadyPending.problem)
        assertEquals(1, keys.creates)
    }

    @Test fun alternateEndpointForSameServerCompletesAsIndependentProfile() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val existingKey = keys.create("existing-key")
        val existingId = "11111111-1111-4111-8111-111111111111"
        val serverId = "01234567-89ab-4def-8123-456789abcdef"
        profiles.stored = StoredServerProfiles(existingId, listOf(StoredServerProfile(
            existingId,
            StoredProfileValue.Ready(PairedDevice(
                "wss://one.example/v2/client", existingKey.alias, "1".repeat(32), serverId,
            )),
        )))
        val credentials = store(profiles, keys)
        val pending = credentials.prepare(qr("wss://two.example/v2/client"), "phone")
        val completed = credentials.complete(
            pending.profileId,
            pending.pairing,
            PairingResult("2".repeat(32), serverId),
        )

        assertEquals(existingId, completed.profiles.selectedId)
        assertEquals(listOf(ServerProfileState.READY, ServerProfileState.READY),
            completed.profiles.profiles.map { it.state })
        assertEquals("1".repeat(32),
            (credentials.credential(existingId) as PairedDevice).deviceId)
        assertEquals("2".repeat(32), completed.credential.deviceId)
        assertTrue(keys.values.containsKey(existingKey.alias))
        assertTrue(keys.values.containsKey(pending.pairing.alias))
    }

    @Test fun exactRepeatedCompletionIsIdempotentButDifferentResultFails() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val credentials = store(profiles, keys)
        val pending = credentials.prepare(qr("wss://one.example/v2/client"), "phone")
        val result = PairingResult(
            "1".repeat(32),
            "01234567-89ab-4def-8123-456789abcdef",
        )
        val first = credentials.complete(pending.profileId, pending.pairing, result)
        val second = credentials.complete(pending.profileId, pending.pairing, result)
        assertEquals(first.profileId, second.profileId)
        assertEquals(first.credential.deviceId, second.credential.deviceId)

        val changed = assertThrows(ProfileStoreFailure::class.java) {
            credentials.complete(
                pending.profileId,
                pending.pairing,
                result.copy(deviceId = "2".repeat(32)),
            )
        }
        assertEquals(ProfileStoreProblem.PendingPairingChanged, changed.problem)
    }

    @Test fun forgetSelectedClearsSelectionAndRenumbersNamesWithoutDeletingKeys() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val firstId = "11111111-1111-4111-8111-111111111111"
        val secondId = "22222222-2222-4222-8222-222222222222"
        val signingKey = keys.create("retained-key")
        profiles.stored = StoredServerProfiles(secondId, listOf(
            StoredServerProfile(firstId, StoredProfileValue.Ready(
                grant("wss://one.example/v2/client"))),
            StoredServerProfile(secondId, StoredProfileValue.Ready(PairedDevice(
                "wss://two.example/v2/client",
                signingKey.alias,
                "2".repeat(32),
                "01234567-89ab-4def-8123-456789abcdef",
            ))),
        ))
        val credentials = store(profiles, keys)

        val remaining = credentials.forget(secondId)
        assertEquals(null, remaining.selectedId)
        assertEquals("Server 1", remaining.profiles.single().name)
        assertTrue(keys.values.containsKey(signingKey.alias))
    }

    @Test fun firstPairingStaysUnselectedAcrossReopenUntilExplicitSelection() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val firstStore = store(profiles, keys)
        val pending = firstStore.prepare(qr("wss://one.example/v2/client"), "phone")
        val completed = firstStore.complete(
            pending.profileId,
            pending.pairing,
            PairingResult("1".repeat(32), "01234567-89ab-4def-8123-456789abcdef"),
        )
        assertEquals(null, completed.profiles.selectedId)
        assertTrue(firstStore.load() is StoredCredential.Empty)

        val reopened = store(profiles, keys)
        assertEquals(null, reopened.listProfiles().selectedId)
        assertEquals(pending.profileId, reopened.select(pending.profileId).selectedId)

        val selectedReopen = store(profiles, keys)
        assertEquals(pending.profileId, selectedReopen.listProfiles().selectedId)
        assertEquals(null, selectedReopen.forget(pending.profileId).selectedId)
    }

    @Test fun missingPairedKeyOnlyBreaksThatCredentialNotProfileListing() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        val firstId = "11111111-1111-4111-8111-111111111111"
        val secondId = "22222222-2222-4222-8222-222222222222"
        profiles.stored = StoredServerProfiles(firstId, listOf(
            StoredServerProfile(firstId, StoredProfileValue.Ready(
                grant("wss://one.example/v2/client"))),
            StoredServerProfile(secondId, StoredProfileValue.Ready(PairedDevice(
                "wss://two.example/v2/client",
                "missing-key",
                "2".repeat(32),
                "01234567-89ab-4def-8123-456789abcdef",
            ))),
        ))
        val credentials = store(profiles, keys)

        assertEquals(2, credentials.listProfiles().profiles.size)
        assertEquals("wss://one.example/v2/client", credentials.credential(firstId).endpoint)
        assertThrows(IllegalStateException::class.java) { credentials.credential(secondId) }
        assertEquals(2, credentials.listProfiles().profiles.size)
    }

    @Test fun profileCapacityIsCheckedBeforeGeneratingPairingKey() {
        val profiles = MemoryProfiles()
        val keys = FakeKeys()
        profiles.stored = StoredServerProfiles(
            "00000000-0000-4000-8000-000000000000",
            (0 until 128).map { index ->
                val id = "%08x-0000-4000-8000-%012x".format(index, index)
                StoredServerProfile(id, StoredProfileValue.Ready(
                    grant("wss://server-$index.example/v2/client")))
            },
        )
        val credentials = store(profiles, keys)
        assertThrows(IllegalStateException::class.java) {
            credentials.prepare(qr("wss://overflow.example/v2/client"), "phone")
        }
        assertEquals(0, keys.creates)
        assertEquals(128, profiles.stored!!.profiles.size)
    }
}
