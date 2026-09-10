package com.arthack.agentvoice

import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

internal data class PersonaPreviewBinding(val name: String, val token: String) {
    override fun toString() = "PersonaPreviewBinding(redacted)"

    fun json(): JSONObject = JSONObject().put("socket", name).put("token", token)

    companion object {
        fun parse(name: String?, token: String?): PersonaPreviewBinding? =
            if (name?.matches(Regex("agentvoice-halo-[a-f0-9]{32}")) == true && token?.matches(Regex("[a-f0-9]{64}")) == true)
                PersonaPreviewBinding(name, token) else null

        fun decode(data: JSONObject): PersonaPreviewBinding {
            require(data.fields() == setOf("socket", "token"))
            return requireNotNull(parse(data.getString("socket"), data.getString("token")))
        }
    }
}

internal class StudioBindingStore(
    private val file: File,
    private val random: SecureRandom = SecureRandom(),
) {
    fun loadOrCreate(): PersonaPreviewBinding {
        val exists = file.exists() || File(file.path + ".bak").exists()
        if (!exists) {
            val binding = PersonaPreviewBinding("agentvoice-halo-${random.hex(16)}", random.hex(32))
            replace(binding)
            return binding
        }
        return try {
            PersonaPreviewBinding.decode(JSONObject(AtomicFile(file).readFully().toString(Charsets.UTF_8)))
        } catch (_: Exception) {
            throw StudioBindingException()
        }
    }

    /** Explicit host selection may intentionally replace the private Studio capability. */
    fun replace(binding: PersonaPreviewBinding) {
        try {
            savePersonaTuning(file, binding.json().toString())
        } catch (_: Exception) {
            throw StudioBindingException()
        }
    }

    private fun SecureRandom.hex(bytes: Int): String = ByteArray(bytes).also(::nextBytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

internal class StudioBindingException : IllegalStateException(
    "The private Studio connection file could not be read or created.",
)
