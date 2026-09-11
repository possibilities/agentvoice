package com.arthack.agentvoice

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal class GrantStore(context: Context, directory: File = context.noBackupFilesDir,
    private val alias: String = "agentvoice.device-grant.v1") {
    private val file = AtomicFile(File(directory, "device-grant.v1"))
    private val lockFile = File(directory, "device-grant.lock")
    private val aad = "agentvoice-device-grant-v1".toByteArray(Charsets.UTF_8)

    private fun key(createIfMissing: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!createIfMissing) throw IllegalStateException("Saved device access key is unavailable")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    private fun decode(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()

    private fun exists() = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()
    private fun <T> locked(block: () -> T): T = synchronized(GrantStore::class.java) {
        RandomAccessFile(lockFile, "rw").use { lock -> lock.channel.lock().use { block() } }
    }

    fun load(): DeviceGrant? = locked {
        if (!exists()) return@locked null
        val bytes = file.openRead().use { boundedRead(it, 16_385) }
        requireWire(bytes.size in 30..16_384 && bytes[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(createIfMissing = false),
            GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val plain = cipher.doFinal(bytes, 13, bytes.size - 13)
        try { DeviceGrant.parse(decode(plain)) } finally { plain.fill(0); bytes.fill(0) }
    }

    /** Enrollment cannot replace an existing grant, even through two activity instances. */
    fun saveNew(grant: DeviceGrant) = locked {
        check(!exists()) { "Device access already exists" }
        val bytes = buildJsonObject {
            put("version", 1); put("endpoint", grant.endpoint); put("token", grant.token)
        }.toString().toByteArray(Charsets.UTF_8)
        try {
            requireWire(bytes.size in 1..8192)
            DeviceGrant.parse(decode(bytes))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(createIfMissing = true))
            cipher.updateAAD(aad)
            val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(bytes)
            val stream = file.startWrite()
            try { stream.write(encrypted); file.finishWrite(stream) }
            catch (error: Exception) { file.failWrite(stream); throw error }
        } finally { bytes.fill(0) }
    }
    private fun boundedRead(input: InputStream, maximum: Int): ByteArray {
        val bytes = ByteArray(maximum)
        var count = 0
        while (count < maximum) {
            val read = input.read(bytes, count, maximum - count)
            if (read < 0) break
            if (read == 0) throw ProtocolFailure()
            count += read
        }
        return bytes.copyOf(count).also { bytes.fill(0) }
    }
}
