package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal val previewOrientations = setOf("portrait", "landscape")
internal val previewPersonaSides = setOf("left", "right")

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

internal fun decodePreviewLayout(data: JSONObject): PreviewLayout {
    require(data.fields() == setOf("scales", "verticalOffsetDp", "design", "halo", "spirit", "personaSide"))
    return PreviewLayout(decodePreviewPlacement(data), decodePreviewDesign(data.getJSONObject("design")),
        decodePreviewHalo(data.getJSONObject("halo")), decodePreviewSpirit(data.getJSONObject("spirit")), data.getString("personaSide"))
}

internal fun decodeLandscapeLayout(json: String): PreviewLayout {
    val data = JSONObject(json)
    return if (data.getInt("version") == 11) decodePreviewLayout(data.getJSONObject("landscape")) else PreviewLayout()
}

internal fun decodePortraitSide(json: String): String {
    val data = JSONObject(json)
    return (if (data.getInt("version") == 11) data.getString("personaSide") else "left")
        .also { require(it in previewPersonaSides) }
}
