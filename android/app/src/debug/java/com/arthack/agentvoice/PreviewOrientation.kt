package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal val previewOrientations = setOf("portrait", "landscape")
internal val previewPersonaSides = setOf("left", "right")
internal val previewThemes = setOf("bright", "quiet", "grayscale")
internal val previewMutedPresences = setOf("tide", "off")

/** Only the activity observes orientation; a host request can never select it. */
internal data class PreviewLayout(
    val placement: PersonaPlacement = PersonaPlacement(offsetY = 0.dp),
    val design: PreviewDesign = PreviewDesign(),
    val halo: PreviewHalo = PreviewHalo(),
    val spirit: PreviewSpirit = PreviewSpirit(),
    val personaSide: String = "left",
) {
    init { require(personaSide in previewPersonaSides) }
    fun json(): JSONObject = JSONObject().put("scales", placement.scalesJson())
        .put("verticalOffsetDp", placement.offsetY.value.toInt()).put("design", design.json())
        .put("halo", halo.json()).put("spirit", spirit.json()).put("personaSide", personaSide)
}

/** Provisional studio defaults never change production PersonaPlacement or legacy profile omissions. */
internal fun defaultPortraitLayout() = PreviewLayout(
    placement = PersonaPlacement(.78f, .56f, .78f, (-22).dp),
    design = PreviewDesign(controlsHeightDp = 387, holdSharePercent = 40.9,
        traces = PreviewTraces("parallel", 130, 175, 88, 0)),
    halo = PreviewHalo(variant = "contained"),
    spirit = PreviewSpirit(persona = "follow"),
)

internal fun defaultLandscapeLayout() = PreviewLayout()

internal fun defaultPreviewLayout(orientation: String): PreviewLayout {
    require(orientation in previewOrientations)
    return if (orientation == "portrait") defaultPortraitLayout() else defaultLandscapeLayout()
}

internal fun decodePreviewLayout(data: JSONObject, version: Int = 12): PreviewLayout {
    require(data.fields() == setOf("scales", "verticalOffsetDp", "design", "halo", "spirit", "personaSide"))
    val design = data.getJSONObject("design")
    return PreviewLayout(decodePreviewPlacement(data), decodePreviewDesign(if (version <= 11) withLegacyPreviewSpacing(design) else design),
        decodePreviewHalo(data.getJSONObject("halo")), decodePreviewSpirit(data.getJSONObject("spirit")), data.getString("personaSide"))
}

internal fun decodeLandscapeLayout(json: String): PreviewLayout {
    val data = JSONObject(json)
    val version = data.getInt("version")
    require(version in 1..12)
    return if (version >= 11) decodePreviewLayout(data.getJSONObject("landscape"), version) else defaultLandscapeLayout()
}

internal fun decodePortraitSide(json: String): String {
    val data = JSONObject(json)
    val version = data.getInt("version")
    require(version in 1..12)
    return (if (version >= 11) data.getString("personaSide") else "left")
        .also { require(it in previewPersonaSides) }
}
