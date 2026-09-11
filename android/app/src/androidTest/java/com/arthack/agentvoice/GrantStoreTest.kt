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

class GrantStoreTest {
    private val fixtureId = UUID.randomUUID().toString()
    private val alias = "agentvoice.test.device-grant.$fixtureId"
    private val directory = File(
        InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir,
        "grant-store-test-$fixtureId",
    ).also { check(it.mkdirs()) }

    private val token = "${"a".repeat(32)}.${"b".repeat(64)}"
    private val replacementToken = "${"c".repeat(32)}.${"d".repeat(64)}"
    private fun grant(token: String = this.token) = DeviceGrant.parse(
        """{"version":1,"endpoint":"wss://example.test/v2/client","token":"$token"}""",
    )

    @After fun cleanOwnedFixtures() {
        directory.deleteRecursively()
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keys.containsAlias(alias)) keys.deleteEntry(alias)
    }

    @Test fun encryptedGrantRoundTripsWithoutPlaintextOverwriteOrMalformedFallback() {
        val first = GrantStore(
            InstrumentationRegistry.getInstrumentation().targetContext,
            directory,
            alias,
        )
        assertEquals(null, first.load())
        first.saveNew(grant())

        val storedFile = File(directory, "device-grant.v1")
        val originalBytes = storedFile.readBytes()
        assertTrue(originalBytes.isNotEmpty())
        assertFalse(originalBytes.containsSequence(token.toByteArray(Charsets.UTF_8)))

        val reopened = GrantStore(
            InstrumentationRegistry.getInstrumentation().targetContext,
            directory,
            alias,
        )
        assertEquals("wss://example.test/v2/client", reopened.load()!!.endpoint)
        assertEquals(token, reopened.load()!!.token)
        assertThrows(IllegalStateException::class.java) { reopened.saveNew(grant(replacementToken)) }
        assertArrayEquals(originalBytes, storedFile.readBytes())
        assertEquals(token, GrantStore(
            InstrumentationRegistry.getInstrumentation().targetContext,
            directory,
            alias,
        ).load()!!.token)

        val malformed = originalBytes.clone().also {
            it[it.lastIndex] = (it.last().toInt() xor 1).toByte()
        }
        storedFile.writeBytes(malformed)
        assertThrows(Exception::class.java) {
            GrantStore(
                InstrumentationRegistry.getInstrumentation().targetContext,
                directory,
                alias,
            ).load()
        }
        assertArrayEquals(malformed, storedFile.readBytes())
    }

    @Test fun missingEncryptionKeyFailsWithoutCreatingAReplacement() {
        val store = GrantStore(
            InstrumentationRegistry.getInstrumentation().targetContext,
            directory,
            alias,
        )
        store.saveNew(grant())
        val storedFile = File(directory, "device-grant.v1")
        val originalBytes = storedFile.readBytes()
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        keys.deleteEntry(alias)

        assertThrows(IllegalStateException::class.java) { store.load() }
        val reopened = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(reopened.containsAlias(alias))
        assertArrayEquals(originalBytes, storedFile.readBytes())
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
