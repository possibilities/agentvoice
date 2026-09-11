package com.arthack.agentvoice

import android.util.AtomicFile
import androidx.compose.ui.unit.dp
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
        2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 -> data.getJSONObject("scaleMultipliers").let {
            PersonaPlacement(scale(it, "speaking"), scale(it, "listening"), scale(it, "idle"))
        }
        else -> error("Unsupported Persona tuning version")
    }
    return if (data.has("verticalOffsetDp")) placement.copy(offsetY = decodePreviewOffset(data.get("verticalOffsetDp")).dp)
        else placement
}

internal fun encodePersonaTuning(placement: PersonaPlacement, design: PreviewDesign = PreviewDesign(), halo: PreviewHalo = PreviewHalo(), spirit: PreviewSpirit = PreviewSpirit(), landscape: PreviewLayout = PreviewLayout(), personaSide: String = "left", horizontalOffsetDp: Int = 0, appearanceOverrides: Set<String> = emptySet(),
    sharedAppearance: PreviewSharedAppearance = PreviewSharedAppearance.from(PreviewLayout(placement, design, halo, spirit, personaSide)),
    sounds: PreviewSounds = PreviewSounds(), appearance: DesignAppearance = DesignAppearance(),
    portraitReverse: PreviewLayout = PreviewLayout(placement, design, halo, spirit, personaSide, horizontalOffsetDp, appearanceOverrides),
    landscapeReverse: PreviewLayout = landscape): String {
    fun percent(scale: Float) = (scale * 100).roundToInt() / 100.0
    return JSONObject()
        .put("version", 21).put("sounds", sounds.json())
        .also { root -> appearance.json().let { values -> values.keys().forEach { key -> root.put(key, values.get(key)) } } }
        .put("horizontalOffsetDp", horizontalOffsetDp).put("appearanceOverrides", appearanceOverrides.appearanceJson())
        .put("sharedAppearance", sharedAppearance.json())
        .put("portraitReverse", portraitReverse.copy(design = portraitReverse.design.copy(spacing = design.spacing)).json())
        .put("landscapeReverse", landscapeReverse.copy(design = landscapeReverse.design.copy(spacing = design.spacing)).json())
        .put("landscape", landscape.copy(design = landscape.design.copy(spacing = design.spacing)).json()).put("personaSide", personaSide)
        .put("spirit", spirit.json())
        .put("halo", halo.json())
        .put("design", design.json())
        .put("scaleMultipliers", JSONObject()
            .put("speaking", percent(placement.speakingScale))
            .put("listening", percent(placement.listeningScale))
            .put("idle", percent(placement.idleScale)))
        .put("verticalOffsetDp", placement.offsetY.value.roundToInt())
        .put("connectedArtboardScale", 1.9)
        .put("disconnectedArtboardScale", 1.9)
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
