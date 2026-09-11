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
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal interface DeviceSigningKey {
    val alias: String
    val publicKey: ByteArray
    fun sign(value: ByteArray): ByteArray
}

internal interface DeviceKeyProvider {
    fun create(alias: String): DeviceSigningKey
    fun open(alias: String): DeviceSigningKey
}

internal class AndroidDeviceKeyProvider : DeviceKeyProvider {
    override fun create(alias: String): DeviceSigningKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        check(!store.containsAlias(alias)) { "Device signing key already exists" }
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build())
        }.generateKeyPair()
        return open(alias)
    }

    override fun open(alias: String): DeviceSigningKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val entry = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: throw IllegalStateException("Saved device signing key is unavailable")
        requireWire(entry.privateKey.algorithm == "EC" && entry.certificate.publicKey.algorithm == "EC")
        val ec = entry.certificate.publicKey as? ECPublicKey ?: throw ProtocolFailure()
        requireWire(ec.params.curve.field.fieldSize == 256 && ec.params.order.bitLength() == 256)
        val encoded = entry.certificate.publicKey.encoded ?: throw ProtocolFailure()
        requireWire(encoded.size in 1..512)
        return AndroidSigningKey(alias, entry.privateKey, encoded)
    }

    private class AndroidSigningKey(
        override val alias: String,
        private val privateKey: PrivateKey,
        override val publicKey: ByteArray,
    ) : DeviceSigningKey {
        override fun sign(value: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(value)
            sign().also { requireWire(it.size in 64..80) }
        }
    }
}

internal sealed interface PairingStoredState {
    data class Pending(val value: PendingPairing) : PairingStoredState
    data class Ready(val value: PairedDevice) : PairingStoredState
}

internal interface PairingStateStorage {
    fun load(): PairingStoredState?
    fun saveNew(value: PendingPairing)
    fun complete(expected: PendingPairing, result: PairingResult): PairedDevice
}

/** Encrypted, atomic no-backup state. A pending record is replaced only by its own success. */
internal class EncryptedPairingStateStorage(
    context: Context,
    directory: File = context.noBackupFilesDir,
    private val keyAlias: String = "agentvoice.device-pairing-state.v1",
) : PairingStateStorage {
    private val file = AtomicFile(File(directory, "device-pairing.v1"))
    private val lockFile = File(directory, "device-pairing.lock")
    private val aad = "agentvoice-device-pairing-v1".toByteArray(Charsets.UTF_8)

    private fun encryptionKey(createIfMissing: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        if (!createIfMissing) throw IllegalStateException("Saved pairing encryption key is unavailable")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    private fun exists() = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()
    private fun <T> locked(block: () -> T): T = synchronized(EncryptedPairingStateStorage::class.java) {
        RandomAccessFile(lockFile, "rw").use { lock -> lock.channel.lock().use { block() } }
    }

    override fun load(): PairingStoredState? = locked { readLocked() }

    override fun saveNew(value: PendingPairing) = locked {
        check(!exists()) { "Device access already exists" }
        writeLocked(serialize(PairingStoredState.Pending(value)), createKey = true)
    }

    override fun complete(expected: PendingPairing, result: PairingResult): PairedDevice = locked {
        val current = readLocked()
        check(current is PairingStoredState.Pending && current.value.sameRequest(expected)) {
            "Saved pairing request changed"
        }
        val paired = PairedDevice(expected.qr.endpoint, expected.alias, result.deviceId, result.serverId)
        writeLocked(serialize(PairingStoredState.Ready(paired)), createKey = false)
        paired
    }

    private fun readLocked(): PairingStoredState? {
        if (!exists()) return null
        val bytes = file.openRead().use { boundedRead(it, 16_385) }
        requireWire(bytes.size in 30..16_384 && bytes[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(createIfMissing = false),
            GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val plain = cipher.doFinal(bytes, 13, bytes.size - 13)
        return try { parse(decode(plain)) } finally { plain.fill(0); bytes.fill(0) }
    }

    private fun writeLocked(text: String, createKey: Boolean) {
        val plain = text.toByteArray(Charsets.UTF_8)
        try {
            requireWire(plain.size in 1..8192)
            parse(decode(plain))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, encryptionKey(createIfMissing = createKey))
            cipher.updateAAD(aad)
            val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(plain)
            val output = file.startWrite()
            try {
                output.write(encrypted)
                file.finishWrite(output)
            } catch (error: Exception) {
                file.failWrite(output)
                throw error
            } finally {
                encrypted.fill(0)
            }
        } finally {
            plain.fill(0)
        }
    }

    private fun serialize(state: PairingStoredState): String = when (state) {
        is PairingStoredState.Pending -> buildJsonObject {
            put("version", 1)
            put("state", "pending")
            put("endpoint", state.value.qr.endpoint)
            put("enrollment", state.value.qr.enrollment)
            put("expiresAt", state.value.qr.expiresAt)
            put("requestId", state.value.requestId)
            put("label", state.value.label)
            put("alias", state.value.alias)
            put("publicKey", state.value.publicKey)
        }.toString()
        is PairingStoredState.Ready -> buildJsonObject {
            put("version", 1)
            put("state", "ready")
            put("endpoint", state.value.endpoint)
            put("alias", state.value.alias)
            put("deviceId", state.value.deviceId)
            put("serverId", state.value.serverId)
        }.toString()
    }

    private fun parse(text: String): PairingStoredState {
        val value = jsonObject(text)
        requireWire(value["version"] == JsonPrimitive(1))
        return when (value.string("state")) {
            "pending" -> {
                value.fields("version", "state", "endpoint", "enrollment", "expiresAt",
                    "requestId", "label", "alias", "publicKey")
                val qrText = buildJsonObject {
                    put("v", 1)
                    put("endpoint", value.string("endpoint"))
                    put("enrollment", value.string("enrollment"))
                    put("expiresAt", value.number("expiresAt"))
                }.toString()
                PairingStoredState.Pending(PendingPairing(
                    PairingQr.parse(PAIRING_QR_PREFIX + qrText),
                    value.string("requestId"), value.string("label"), value.string("alias"),
                    value.string("publicKey"),
                ))
            }
            "ready" -> {
                value.fields("version", "state", "endpoint", "alias", "deviceId", "serverId")
                PairingStoredState.Ready(PairedDevice(value.string("endpoint"), value.string("alias"),
                    value.string("deviceId"), value.string("serverId")))
            }
            else -> throw ProtocolFailure()
        }
    }

    private fun decode(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()

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

    private fun kotlinx.serialization.json.JsonObject.number(name: String): Long {
        val primitive = get(name) as? JsonPrimitive ?: throw ProtocolFailure()
        requireWire(!primitive.isString)
        return primitive.longOrNull ?: throw ProtocolFailure()
    }
}

internal data class PendingPairingInfo(
    val endpoint: String,
    val label: String,
    val requestId: String,
    val expiresAt: Long,
)

internal sealed interface StoredCredential {
    data object Empty : StoredCredential
    data class Ready(val credential: CallCredential) : StoredCredential
    data class Pending(val info: PendingPairingInfo) : StoredCredential
}

internal class DeviceCredentialStore internal constructor(
    private val legacyLoad: () -> DeviceGrant?,
    private val states: PairingStateStorage,
    internal val keys: DeviceKeyProvider,
) {
    constructor(context: Context) : this(
        legacyLoad = GrantStore(context)::load,
        states = EncryptedPairingStateStorage(context),
        keys = AndroidDeviceKeyProvider(),
    )

    fun load(): StoredCredential = synchronized(DeviceCredentialStore::class.java) {
        val legacy = legacyLoad()
        val state = states.load()
        check(legacy == null || state == null) { "Conflicting saved device access" }
        if (legacy != null) return@synchronized StoredCredential.Ready(legacy)
        when (state) {
            null -> StoredCredential.Empty
            is PairingStoredState.Pending -> {
                validateKey(state.value)
                StoredCredential.Pending(state.value.info())
            }
            is PairingStoredState.Ready -> {
                keys.open(state.value.alias)
                StoredCredential.Ready(state.value)
            }
        }
    }

    internal fun prepare(qr: PairingQr, label: String): PendingPairing =
        synchronized(DeviceCredentialStore::class.java) {
            check(load() == StoredCredential.Empty) { "Device access already exists" }
            val alias = "agentvoice.device-auth.v1.${UUID.randomUUID()}"
            val key = keys.create(alias)
            val pending = PendingPairing(qr, UUID.randomUUID().toString(),
                normalizePairingLabel(label), alias, encodeBase64Url(key.publicKey))
            states.saveNew(pending)
            pending
        }

    internal fun pendingForRetry(): PendingPairing = synchronized(DeviceCredentialStore::class.java) {
        check(legacyLoad() == null) { "Device access already exists" }
        val pending = (states.load() as? PairingStoredState.Pending)?.value
            ?: throw IllegalStateException("No pairing request is waiting")
        validateKey(pending)
        pending
    }

    internal fun complete(expected: PendingPairing, result: PairingResult): PairedDevice =
        synchronized(DeviceCredentialStore::class.java) {
            check(legacyLoad() == null) { "Device access already exists" }
            val paired = states.complete(expected, result)
            keys.open(paired.alias)
            paired
        }

    private fun validateKey(pending: PendingPairing) {
        val key = keys.open(pending.alias)
        requireWire(key.publicKey.contentEquals(decodeBase64Url(pending.publicKey, 384)))
    }

    private fun PendingPairing.info() = PendingPairingInfo(
        qr.endpoint, label, requestId, qr.expiresAt,
    )
}
