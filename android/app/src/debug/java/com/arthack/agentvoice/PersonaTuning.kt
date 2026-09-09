package com.arthack.agentvoice

import android.util.AtomicFile
import androidx.compose.runtime.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

internal val previewModes = setOf("speaking", "listening", "idle")
internal fun JSONObject.fields(): Set<String> = keys().asSequence().toSet()

internal fun decodePersonaTuning(json: String): PersonaPlacement {
    val data = JSONObject(json)
    fun scale(values: JSONObject, key: String): Float {
        val value = values.getDouble(key).toFloat()
        require(value.isFinite())
        return value.coerceIn(.35f, 1.2f)
    }
    return when (data.getInt("version")) {
        // Loading never rewrites the original choice; migration happens only on Save.
        1 -> scale(data, "scaleMultiplier").let { PersonaPlacement(it, it, it) }
        2 -> data.getJSONObject("scaleMultipliers").let {
            PersonaPlacement(scale(it, "speaking"), scale(it, "listening"), scale(it, "idle"))
        }
        else -> error("Unsupported Persona tuning version")
    }
}

internal fun encodePersonaTuning(placement: PersonaPlacement): String {
    fun percent(scale: Float) = (scale * 100).roundToInt() / 100.0
    return JSONObject()
        .put("version", 2)
        .put("scaleMultipliers", JSONObject()
            .put("speaking", percent(placement.speakingScale))
            .put("listening", percent(placement.listeningScale))
            .put("idle", percent(placement.idleScale)))
        .put("verticalOffsetDp", placement.offsetY.value.roundToInt())
        .put("connectedArtboardScale", 1.9)
        .put("disconnectedArtboardScale", 1.5)
        .put("savedAtEpochMs", System.currentTimeMillis())
        .toString(2)
}

internal fun savePersonaTuning(file: File, profile: String) {
    val target = AtomicFile(file)
    val stream = target.startWrite()
    try {
        stream.write(profile.toByteArray(Charsets.UTF_8))
        target.finishWrite(stream)
    } catch (failure: Throwable) {
        target.failWrite(stream)
        throw failure
    }
}

internal fun PersonaPlacement.scalesJson() = JSONObject()
    .put("speaking", (speakingScale * 100).roundToInt())
    .put("listening", (listeningScale * 100).roundToInt())
    .put("idle", (idleScale * 100).roundToInt())

internal fun decodePreviewScales(data: JSONObject): PersonaPlacement {
    require(data.fields() == previewModes)
    fun scale(key: String): Float {
        val number = data.get(key)
        require(number is Number && number.toDouble() % 1.0 == 0.0 && number.toDouble() in 35.0..120.0)
        return number.toFloat() / 100f
    }
    return PersonaPlacement(scale("speaking"), scale("listening"), scale("idle"))
}

internal data class PersonaPreviewState(
    val placement: PersonaPlacement = PersonaPlacement(),
    val saved: PersonaPlacement = placement,
    val mode: String = "speaking",
    val holding: Boolean = false,
    val revision: Int = 0,
) {
    fun json(): JSONObject = JSONObject().put("protocol", 1).put("revision", revision)
        .put("mode", mode).put("holding", holding).put("scales", placement.scalesJson())
        .put("savedScales", saved.scalesJson()).put("defaults", PersonaPlacement().scalesJson())

    fun select(next: String) = copy(mode = next, holding = false, revision = revision + 1)

    fun ui() = CallUi(running = true, connected = true, phase = "Connected",
        micMuted = mode != "listening" || holding, micOpen = mode == "listening", speakerMuted = false,
        speakerOpen = true, canHold = mode != "listening" || holding, holding = holding,
        outputLevel = if (mode == "speaking") .14f else 0f)
}

internal class PersonaPreviewSession(initial: PersonaPlacement, private val selection: File) {
    var state by mutableStateOf(PersonaPreviewState(placement = initial))

    suspend fun command(request: JSONObject): JSONObject {
        val method = request.getString("method")
        var profile: String? = null
        if (method == "save") {
            require(request.fields() == setOf("id", "method", "revision"))
            val placement = withContext(Dispatchers.Main) {
                check(request.get("revision") == state.revision) { "Preview changed. Review it before saving." }
                state.placement
            }
            profile = encodePersonaTuning(placement)
            savePersonaTuning(selection, profile)
            withContext(Dispatchers.Main) { state = state.copy(saved = placement) }
        }
        return withContext(Dispatchers.Main) {
            when (method) {
                "get" -> require(request.fields() == setOf("id", "method"))
                "preview" -> {
                    require(request.fields() == setOf("id", "method", "mode", "scales"))
                    val mode = request.getString("mode")
                    require(mode in previewModes)
                    val placement = decodePreviewScales(request.getJSONObject("scales"))
                    state = state.select(mode).copy(placement = placement)
                }
                "save" -> Unit
                else -> error("Unknown preview command")
            }
            JSONObject().put("state", state.json()).also { if (profile != null) it.put("profile", profile) }
        }
    }
}
