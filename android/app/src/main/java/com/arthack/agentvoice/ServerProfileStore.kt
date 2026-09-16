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
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal enum class ServerProfileState { READY, PENDING }

/** A presentation snapshot. Names are gapless list ordinals and are never persisted. */
internal data class ServerProfile(
    val id: String,
    val name: String,
    val endpoint: String,
    val state: ServerProfileState,
)

internal data class ServerProfiles(
    val selectedId: String?,
    val profiles: List<ServerProfile>,
)

internal data class PendingPairingInfo(
    val profileId: String,
    val endpoint: String,
    val label: String,
    val requestId: String,
    val expiresAt: Long,
)

internal sealed interface StoredCredential {
    data object Empty : StoredCredential
    data class Ready(val profileId: String, val credential: CallCredential) : StoredCredential
    data class Pending(val info: PendingPairingInfo) : StoredCredential
}

internal data class PendingPairingProfile(
    val profileId: String,
    val pairing: PendingPairing,
)

internal data class CompletedPairing(
    val profileId: String,
    val credential: PairedDevice,
    val profiles: ServerProfiles,
)

internal enum class ProfileStoreProblem {
    DuplicateEndpoint,
    PairingAlreadyPending,
    ProfileNotFound,
    ProfileNotReady,
    PendingPairingChanged,
}

internal class ProfileStoreFailure(val problem: ProfileStoreProblem, message: String) :
    IllegalStateException(message)

internal sealed interface StoredProfileValue {
    data class Ready(val credential: CallCredential) : StoredProfileValue
    data class Pending(val pairing: PendingPairing) : StoredProfileValue
}

internal data class StoredServerProfile(
    val id: String,
    val value: StoredProfileValue,
) {
    val endpoint: String get() = when (value) {
        is StoredProfileValue.Ready -> value.credential.endpoint
        is StoredProfileValue.Pending -> value.pairing.qr.endpoint
    }
}

internal data class StoredServerProfiles(
    val selectedId: String?,
    val profiles: List<StoredServerProfile>,
)

internal interface ServerProfileStorage {
    fun loadOrCreate(initial: () -> StoredServerProfiles): StoredServerProfiles
    fun update(
        initial: () -> StoredServerProfiles,
        transform: (StoredServerProfiles) -> StoredServerProfiles,
    ): StoredServerProfiles
}

/** Encrypted, atomic no-backup collection. An empty collection is retained as a migration marker. */
internal class EncryptedServerProfileStorage(
    context: Context,
    directory: File = context.noBackupFilesDir,
    private val keyAlias: String = "agentvoice.device-server-profiles.v1",
) : ServerProfileStorage {
    private val file = AtomicFile(File(directory, "device-server-profiles.v1"))
    private val lockFile = File(directory, "device-server-profiles.lock")
    private val aad = "agentvoice-device-server-profiles-v1".toByteArray(Charsets.UTF_8)

    private fun encryptionKey(createIfMissing: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        if (!createIfMissing) {
            throw IllegalStateException("Saved server profile encryption key is unavailable")
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    private fun exists() = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()

    private fun <T> locked(block: () -> T): T = synchronized(EncryptedServerProfileStorage::class.java) {
        RandomAccessFile(lockFile, "rw").use { lock -> lock.channel.lock().use { block() } }
    }

    override fun loadOrCreate(initial: () -> StoredServerProfiles): StoredServerProfiles = locked {
        readLocked() ?: initial().also { writeLocked(it, createKey = true) }
    }

    override fun update(
        initial: () -> StoredServerProfiles,
        transform: (StoredServerProfiles) -> StoredServerProfiles,
    ): StoredServerProfiles = locked {
        val existed = exists()
        val next = transform(readLocked() ?: initial())
        writeLocked(next, createKey = !existed)
        next
    }

    private fun readLocked(): StoredServerProfiles? {
        if (!exists()) return null
        val encrypted = file.openRead().use { boundedRead(it, MAX_PROFILE_FILE_BYTES + 1) }
        requireWire(encrypted.size in 30..MAX_PROFILE_FILE_BYTES && encrypted[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            encryptionKey(createIfMissing = false),
            GCMParameterSpec(128, encrypted.copyOfRange(1, 13)),
        )
        cipher.updateAAD(aad)
        val plain = cipher.doFinal(encrypted, 13, encrypted.size - 13)
        return try {
            parseProfiles(decode(plain))
        } finally {
            plain.fill(0)
            encrypted.fill(0)
        }
    }

    private fun writeLocked(value: StoredServerProfiles, createKey: Boolean) {
        val plain = serializeProfiles(value).toByteArray(Charsets.UTF_8)
        try {
            requireWire(plain.size in 1..MAX_PROFILE_PLAINTEXT_BYTES)
            parseProfiles(decode(plain))
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

    private companion object {
        const val MAX_PROFILE_FILE_BYTES = 256 * 1024
        const val MAX_PROFILE_PLAINTEXT_BYTES = MAX_PROFILE_FILE_BYTES - 29
    }
}

internal class DeviceCredentialStore internal constructor(
    private val profiles: ServerProfileStorage,
    private val legacyGrantLoad: () -> DeviceGrant?,
    private val legacyPairingLoad: () -> PairingStoredState?,
    internal val keys: DeviceKeyProvider,
) {
    constructor(context: Context) : this(
        profiles = EncryptedServerProfileStorage(context),
        legacyGrantLoad = GrantStore(context)::load,
        legacyPairingLoad = EncryptedPairingStateStorage(context)::load,
        keys = AndroidDeviceKeyProvider(),
    )

    fun listProfiles(): ServerProfiles = synchronized(DeviceCredentialStore::class.java) {
        snapshot(loadProfiles())
    }

    fun select(id: String): ServerProfiles = synchronized(DeviceCredentialStore::class.java) {
        snapshot(profiles.update(::migrateLegacy) { current ->
            val profile = current.profiles.firstOrNull { it.id == id }
                ?: throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotFound, "Server profile not found")
            if (profile.value !is StoredProfileValue.Ready) {
                throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotReady, "Server profile is not ready")
            }
            current.copy(selectedId = id)
        })
    }

    fun credential(id: String): CallCredential = synchronized(DeviceCredentialStore::class.java) {
        val profile = loadProfiles().profiles.firstOrNull { it.id == id }
            ?: throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotFound, "Server profile not found")
        val ready = profile.value as? StoredProfileValue.Ready
            ?: throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotReady, "Server profile is not ready")
        ready.credential.also { credential ->
            if (credential is PairedDevice) keys.open(credential.alias)
        }
    }

    /** Removes only the collection entry. Rollback files and nonexportable keys remain untouched. */
    fun forget(id: String): ServerProfiles = synchronized(DeviceCredentialStore::class.java) {
        snapshot(profiles.update(::migrateLegacy) { current ->
            if (current.profiles.none { it.id == id }) {
                throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotFound, "Server profile not found")
            }
            val remaining = current.profiles.filterNot { it.id == id }
            val selected = if (current.selectedId == id) {
                null
            } else {
                current.selectedId
            }
            StoredServerProfiles(selected, remaining)
        })
    }

    /** Compatibility view used while call startup moves to explicit selected profile IDs. */
    fun load(): StoredCredential = synchronized(DeviceCredentialStore::class.java) {
        val current = loadProfiles()
        current.selectedId?.let { selected ->
            return@synchronized StoredCredential.Ready(selected, credentialFrom(current, selected))
        }
        val pending = current.profiles.singleOrNull { it.value is StoredProfileValue.Pending }
        if (pending == null) StoredCredential.Empty else {
            val value = (pending.value as StoredProfileValue.Pending).pairing
            StoredCredential.Pending(value.info(pending.id))
        }
    }

    internal fun prepare(qr: PairingQr, label: String): PendingPairingProfile =
        synchronized(DeviceCredentialStore::class.java) {
            lateinit var prepared: PendingPairingProfile
            profiles.update(::migrateLegacy) { current ->
                if (current.profiles.any { it.value is StoredProfileValue.Pending }) {
                    throw ProfileStoreFailure(
                        ProfileStoreProblem.PairingAlreadyPending,
                        "Another server pairing is already waiting",
                    )
                }
                if (current.profiles.any { sameEndpoint(it.endpoint, qr.endpoint) }) {
                    throw ProfileStoreFailure(
                        ProfileStoreProblem.DuplicateEndpoint,
                        "This server endpoint is already saved",
                    )
                }
                if (current.profiles.size >= 128) {
                    throw IllegalStateException("Too many saved server profiles")
                }
                val profileId = UUID.randomUUID().toString()
                val alias = "agentvoice.device-auth.v1.${UUID.randomUUID()}"
                val key = keys.create(alias)
                val pending = PendingPairing(
                    qr,
                    UUID.randomUUID().toString(),
                    normalizePairingLabel(label),
                    alias,
                    encodeBase64Url(key.publicKey),
                )
                prepared = PendingPairingProfile(profileId, pending)
                current.copy(profiles = current.profiles + StoredServerProfile(
                    profileId,
                    StoredProfileValue.Pending(pending),
                ))
            }
            prepared
        }

    internal fun pendingForRetry(profileId: String): PendingPairingProfile =
        synchronized(DeviceCredentialStore::class.java) {
            val profile = loadProfiles().profiles.firstOrNull { it.id == profileId }
                ?: throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotFound, "Server profile not found")
            val pending = (profile.value as? StoredProfileValue.Pending)?.pairing
                ?: throw ProfileStoreFailure(
                    ProfileStoreProblem.ProfileNotReady,
                    "Server profile has no pending pairing request",
                )
            validateKey(pending)
            PendingPairingProfile(profileId, pending)
        }

    internal fun complete(
        profileId: String,
        expected: PendingPairing,
        result: PairingResult,
    ): CompletedPairing = synchronized(DeviceCredentialStore::class.java) {
        lateinit var paired: PairedDevice
        val updated = profiles.update(::migrateLegacy) { current ->
            val index = current.profiles.indexOfFirst { it.id == profileId }
            if (index < 0) {
                throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotFound, "Server profile not found")
            }
            val stored = current.profiles[index].value
            if (stored is StoredProfileValue.Ready) {
                val ready = stored.credential as? PairedDevice
                if (ready != null && ready.endpoint == expected.qr.endpoint &&
                    ready.alias == expected.alias && ready.deviceId == result.deviceId &&
                    ready.serverId == result.serverId) {
                    validateKey(expected)
                    paired = ready
                    return@update current
                }
                throw ProfileStoreFailure(
                    ProfileStoreProblem.PendingPairingChanged,
                    "Saved pairing request changed",
                )
            }
            val pending = (stored as? StoredProfileValue.Pending)?.pairing
                ?: throw ProfileStoreFailure(
                    ProfileStoreProblem.PendingPairingChanged,
                    "Saved pairing request changed",
                )
            if (!pending.sameRequest(expected)) {
                throw ProfileStoreFailure(
                    ProfileStoreProblem.PendingPairingChanged,
                    "Saved pairing request changed",
                )
            }
            validateKey(pending)
            paired = PairedDevice(pending.qr.endpoint, pending.alias, result.deviceId, result.serverId)
            current.copy(
                profiles = current.profiles.toMutableList().also {
                    it[index] = StoredServerProfile(profileId, StoredProfileValue.Ready(paired))
                },
            )
        }
        CompletedPairing(profileId, paired, snapshot(updated))
    }

    private fun loadProfiles(): StoredServerProfiles = profiles.loadOrCreate(::migrateLegacy)

    private fun migrateLegacy(): StoredServerProfiles {
        val migrated = mutableListOf<StoredServerProfile>()
        legacyGrantLoad()?.let {
            migrated += StoredServerProfile(UUID.randomUUID().toString(), StoredProfileValue.Ready(it))
        }
        legacyPairingLoad()?.let { state ->
            migrated += StoredServerProfile(
                UUID.randomUUID().toString(),
                when (state) {
                    is PairingStoredState.Pending -> StoredProfileValue.Pending(state.value)
                    is PairingStoredState.Ready -> StoredProfileValue.Ready(state.value)
                },
            )
        }
        val selected = migrated.firstOrNull { it.value is StoredProfileValue.Ready }?.id
        return validateProfiles(StoredServerProfiles(selected, migrated))
    }

    private fun credentialFrom(current: StoredServerProfiles, id: String): CallCredential {
        val ready = current.profiles.firstOrNull { it.id == id }?.value as? StoredProfileValue.Ready
            ?: throw ProfileStoreFailure(ProfileStoreProblem.ProfileNotReady, "Selected server is not ready")
        return ready.credential.also { credential ->
            if (credential is PairedDevice) keys.open(credential.alias)
        }
    }

    private fun validateKey(pending: PendingPairing) {
        val key = keys.open(pending.alias)
        requireWire(key.publicKey.contentEquals(decodeBase64Url(pending.publicKey, 384)))
    }

    private fun snapshot(value: StoredServerProfiles): ServerProfiles = ServerProfiles(
        value.selectedId,
        value.profiles.mapIndexed { index, profile ->
            ServerProfile(
                profile.id,
                "Server ${index + 1}",
                profile.endpoint,
                if (profile.value is StoredProfileValue.Ready) {
                    ServerProfileState.READY
                } else {
                    ServerProfileState.PENDING
                },
            )
        },
    )

    private fun PendingPairing.info(profileId: String) = PendingPairingInfo(
        profileId,
        qr.endpoint,
        label,
        requestId,
        qr.expiresAt,
    )
}

private val profileIdPattern =
    Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

private fun sameEndpoint(first: String, second: String): Boolean =
    endpointParts(first).wssUrl("/v2/client") == endpointParts(second).wssUrl("/v2/client")

private fun validateProfiles(value: StoredServerProfiles): StoredServerProfiles {
    requireWire(value.profiles.size <= 128)
    requireWire(value.profiles.map { it.id }.all(profileIdPattern::matches))
    requireWire(value.profiles.map { it.id }.distinct().size == value.profiles.size)
    requireWire(value.profiles.count { it.value is StoredProfileValue.Pending } <= 1)
    requireWire(value.profiles.map { endpointParts(it.endpoint).wssUrl("/v2/client") }
        .distinct().size == value.profiles.size)
    val aliases = value.profiles.mapNotNull {
        when (val stored = it.value) {
            is StoredProfileValue.Pending -> stored.pairing.alias
            is StoredProfileValue.Ready -> (stored.credential as? PairedDevice)?.alias
        }
    }
    requireWire(aliases.distinct().size == aliases.size)
    val readyIds = value.profiles.filter { it.value is StoredProfileValue.Ready }.map { it.id }
    requireWire(value.selectedId == null || value.selectedId in readyIds)
    return value
}

private fun serializeProfiles(value: StoredServerProfiles): String {
    validateProfiles(value)
    return buildJsonObject {
        put("version", 1)
        put("selectedId", value.selectedId?.let(::JsonPrimitive) ?: JsonNull)
        put("profiles", buildJsonArray {
            value.profiles.forEach { profile ->
                add(buildJsonObject {
                    put("id", profile.id)
                    when (val stored = profile.value) {
                        is StoredProfileValue.Ready -> when (val credential = stored.credential) {
                            is DeviceGrant -> {
                                put("kind", "bearer")
                                put("endpoint", credential.endpoint)
                                put("token", credential.token)
                            }
                            is PairedDevice -> {
                                put("kind", "paired")
                                put("endpoint", credential.endpoint)
                                put("alias", credential.alias)
                                put("deviceId", credential.deviceId)
                                put("serverId", credential.serverId)
                            }
                            else -> throw ProtocolFailure()
                        }
                        is StoredProfileValue.Pending -> {
                            val pending = stored.pairing
                            put("kind", "pending")
                            put("endpoint", pending.qr.endpoint)
                            put("enrollment", pending.qr.enrollment)
                            put("expiresAt", pending.qr.expiresAt)
                            put("requestId", pending.requestId)
                            put("label", pending.label)
                            put("alias", pending.alias)
                            put("publicKey", pending.publicKey)
                        }
                    }
                })
            }
        })
    }.toString()
}

private fun parseProfiles(text: String): StoredServerProfiles {
    val root = jsonObject(text)
    root.fields("version", "selectedId", "profiles")
    requireWire(root["version"] == JsonPrimitive(1))
    val selected = when (val value = root["selectedId"]) {
        JsonNull -> null
        is JsonPrimitive -> {
            requireWire(value.isString)
            value.content
        }
        else -> throw ProtocolFailure()
    }
    val array = root["profiles"] as? JsonArray ?: throw ProtocolFailure()
    requireWire(array.size <= 128)
    val profiles = array.map { element ->
        val profile = element as? JsonObject ?: throw ProtocolFailure()
        val id = profile.string("id")
        StoredServerProfile(id, when (profile.string("kind")) {
            "bearer" -> {
                profile.fields("id", "kind", "endpoint", "token")
                val grant = buildJsonObject {
                    put("version", 1)
                    put("endpoint", profile.string("endpoint"))
                    put("token", profile.string("token"))
                }
                StoredProfileValue.Ready(DeviceGrant.parse(grant.toString()))
            }
            "paired" -> {
                profile.fields("id", "kind", "endpoint", "alias", "deviceId", "serverId")
                StoredProfileValue.Ready(PairedDevice(
                    profile.string("endpoint"),
                    profile.string("alias"),
                    profile.string("deviceId"),
                    profile.string("serverId"),
                ))
            }
            "pending" -> {
                profile.fields(
                    "id", "kind", "endpoint", "enrollment", "expiresAt", "requestId",
                    "label", "alias", "publicKey",
                )
                val qr = buildJsonObject {
                    put("v", 1)
                    put("endpoint", profile.string("endpoint"))
                    put("enrollment", profile.string("enrollment"))
                    put("expiresAt", profile.number("expiresAt"))
                }
                StoredProfileValue.Pending(PendingPairing(
                    PairingQr.parse(PAIRING_QR_PREFIX + qr),
                    profile.string("requestId"),
                    profile.string("label"),
                    profile.string("alias"),
                    profile.string("publicKey"),
                ))
            }
            else -> throw ProtocolFailure()
        })
    }
    return validateProfiles(StoredServerProfiles(selected, profiles))
}

private fun JsonObject.number(name: String): Long {
    val primitive = get(name) as? JsonPrimitive ?: throw ProtocolFailure()
    requireWire(!primitive.isString)
    return primitive.longOrNull ?: throw ProtocolFailure()
}
