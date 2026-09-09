package com.arthack.agentvoice

import android.util.AtomicFile
import androidx.compose.runtime.*
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

internal val previewConnections = setOf("connected", "connecting", "disconnected")
internal val previewModes = setOf("speaking", "listening", "idle")
internal fun JSONObject.fields(): Set<String> = keys().asSequence().toSet()

internal fun decodePersonaTuning(json: String): PersonaPlacement {
    val data = JSONObject(json)
    fun scale(values: JSONObject, key: String): Float {
        val value = values.getDouble(key).toFloat()
        require(value.isFinite())
        return value.coerceIn(.35f, 1.2f)
    }
    val placement = when (data.getInt("version")) {
        // Loading never rewrites the original choice; migration happens only on Save.
        1 -> scale(data, "scaleMultiplier").let { PersonaPlacement(it, it, it) }
        2, 3, 4, 5 -> data.getJSONObject("scaleMultipliers").let {
            PersonaPlacement(scale(it, "speaking"), scale(it, "listening"), scale(it, "idle"))
        }
        else -> error("Unsupported Persona tuning version")
    }
    return if (data.has("verticalOffsetDp")) placement.copy(offsetY = decodePreviewOffset(data.get("verticalOffsetDp")).dp)
        else placement
}

internal fun encodePersonaTuning(placement: PersonaPlacement, design: PreviewDesign = PreviewDesign(), halo: PreviewHalo = PreviewHalo()): String {
    fun percent(scale: Float) = (scale * 100).roundToInt() / 100.0
    return JSONObject()
        .put("version", 5)
        .put("halo", halo.json())
        .put("design", design.json())
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

internal fun decodePreviewOffset(value: Any): Int {
    require(value is Number && value.toDouble() % 1.0 == 0.0 && value.toDouble() in -200.0..200.0)
    return value.toInt()
}

internal fun decodePreviewPlacement(data: JSONObject): PersonaPlacement =
    decodePreviewScales(data.getJSONObject("scales")).copy(offsetY = decodePreviewOffset(data.get("verticalOffsetDp")).dp)

internal data class PersonaPreviewState(
    val placement: PersonaPlacement = PersonaPlacement(),
    val saved: PersonaPlacement = placement,
    val mode: String = "speaking",
    val connection: String = "connected",
    val holding: Boolean = false,
    val revision: Int = 0,
    val design: PreviewDesign = PreviewDesign(),
    val savedDesign: PreviewDesign = design,
    val halo: PreviewHalo = PreviewHalo(),
    val savedHalo: PreviewHalo = halo,
    val micMuted: Boolean = mode != "listening" || holding,
    val speakerMuted: Boolean = false,
) {
    fun json(): JSONObject = JSONObject().put("protocol", 5).put("connection", connection).put("revision", revision)
        .put("mode", mode).put("holding", holding).put("scales", placement.scalesJson())
        .put("savedScales", saved.scalesJson()).put("defaults", PersonaPlacement().scalesJson())
        .put("verticalOffsetDp", placement.offsetY.value.roundToInt())
        .put("savedVerticalOffsetDp", saved.offsetY.value.roundToInt())
        .put("defaultVerticalOffsetDp", PersonaPlacement().offsetY.value.roundToInt())
        .put("design", design.json()).put("savedDesign", savedDesign.json()).put("defaultDesign", PreviewDesign().json())
        .put("halo", halo.json()).put("savedHalo", savedHalo.json()).put("defaultHalo", PreviewHalo().json())
        .put("micMuted", micMuted).put("speakerMuted", speakerMuted)

    fun select(next: String) = copy(mode = next, holding = false, micMuted = next != "listening", speakerMuted = false, revision = revision + 1)

    fun toggle(target: String): PersonaPreviewState = if (connection != "connected") this else when (target) {
        "mic" -> copy(micMuted = !micMuted, holding = false,
            mode = if (micMuted) "listening" else if (mode == "speaking") "speaking" else "idle", revision = revision + 1)
        "speaker" -> copy(speakerMuted = !speakerMuted, holding = false,
            mode = if (speakerMuted) "speaking" else if (!micMuted) "listening" else "idle", revision = revision + 1)
        else -> error("Unknown channel")
    }

    fun beginHold() = if (connection == "connected" && micMuted) copy(mode = "listening", holding = true, revision = revision + 1) else this
    fun endHold() = if (holding) copy(mode = "idle", micMuted = true, holding = false, revision = revision + 1) else this

    fun ui(): CallUi {
        val connected = connection == "connected"
        return CallUi(running = connection != "disconnected", connected = connected,
            phase = when (connection) { "connecting" -> "Connecting"; "disconnected" -> "Disconnected"; else -> "Connected" },
            micMuted = micMuted, micOpen = connected && (!micMuted || holding), speakerMuted = speakerMuted,
            speakerOpen = connected && !speakerMuted, canHold = connected && micMuted, holding = connected && holding,
            outputLevel = if (connected && mode == "speaking" && !speakerMuted) .14f else 0f)
    }
}

internal fun restorePersonaPreview(data: JSONObject, saved: PersonaPlacement, savedDesign: PreviewDesign = PreviewDesign(), savedHalo: PreviewHalo = PreviewHalo()): PersonaPreviewState {
    val mode = data.getString("mode")
    val revision = data.get("revision")
    require(mode in previewModes && revision is Int && revision >= 0)
    val holding = data.getBoolean("holding")
    val connection = data.optString("connection", "connected")
    require(connection in previewConnections)
    return PersonaPreviewState(placement = decodePreviewPlacement(data), saved = saved,
        mode = if (holding) "idle" else mode, connection = connection, revision = revision,
        design = data.optJSONObject("design")?.let(::decodePreviewDesign) ?: PreviewDesign(), savedDesign = savedDesign,
        halo = data.optJSONObject("halo")?.let(::decodePreviewHalo) ?: PreviewHalo(), savedHalo = savedHalo,
        micMuted = holding || data.optBoolean("micMuted", mode != "listening"), speakerMuted = data.optBoolean("speakerMuted", false))
}

internal class PersonaPreviewSession(initial: PersonaPlacement, private val selection: File, initialDesign: PreviewDesign = PreviewDesign(), initialHalo: PreviewHalo = PreviewHalo()) {
    var state by mutableStateOf(PersonaPreviewState(placement = initial, design = initialDesign, halo = initialHalo))

    suspend fun command(request: JSONObject): JSONObject {
        val method = request.getString("method")
        var profile: String? = null
        if (method == "save") {
            require(request.fields() == setOf("id", "method", "revision"))
            val placement = withContext(Dispatchers.Main) {
                check(request.get("revision") == state.revision) { "Preview changed. Review it before saving." }
                Triple(state.placement, state.design, state.halo)
            }
            profile = encodePersonaTuning(placement.first, placement.second, placement.third)
            savePersonaTuning(selection, profile)
            withContext(Dispatchers.Main) { state = state.copy(saved = placement.first, savedDesign = placement.second, savedHalo = placement.third) }
        }
        return withContext(Dispatchers.Main) {
            when (method) {
                "get" -> require(request.fields() == setOf("id", "method"))
                "preview" -> {
                    require(request.fields() == setOf("id", "method", "connection", "mode", "scales", "verticalOffsetDp", "design", "halo"))
                    val mode = request.getString("mode")
                    require(mode in previewModes)
                    val connection = request.getString("connection")
                    require(connection in previewConnections)
                    val placement = decodePreviewPlacement(request)
                    val design = decodePreviewDesign(request.getJSONObject("design"))
                    val halo = decodePreviewHalo(request.getJSONObject("halo"))
                    val next = if (mode != state.mode) state.select(mode) else state.endHold()
                    state = next.copy(placement = placement, design = design, halo = halo, connection = connection, revision = state.revision + 1)
                }
                "save" -> Unit
                else -> error("Unknown preview command")
            }
            JSONObject().put("state", state.json()).also { if (profile != null) it.put("profile", profile) }
        }
    }
}
