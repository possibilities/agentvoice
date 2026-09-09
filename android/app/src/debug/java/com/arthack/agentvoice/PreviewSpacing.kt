package com.arthack.agentvoice

import org.json.JSONObject

/** Spacing changes the control deck only; Persona placement is owned by its separate layout. */
internal data class PreviewSpacing(
    val sideMarginPercent: Int = 100,
    val edgeClearancePercent: Int = 100,
    val sectionGapDp: Int = 0,
    val channelGapDp: Int = 10,
    val pushGapDp: Int = 16,
) {
    init {
        require(sideMarginPercent in 0..200 && edgeClearancePercent in 0..200)
        require(sectionGapDp in 0..80 && channelGapDp in 0..40 && pushGapDp in 0..48)
    }

    fun json(): JSONObject = JSONObject().put("sideMarginPercent", sideMarginPercent)
        .put("edgeClearancePercent", edgeClearancePercent).put("sectionGapDp", sectionGapDp)
        .put("channelGapDp", channelGapDp).put("pushGapDp", pushGapDp)
}

internal fun decodePreviewSpacing(data: JSONObject): PreviewSpacing {
    require(data.fields() == setOf("sideMarginPercent", "edgeClearancePercent", "sectionGapDp", "channelGapDp", "pushGapDp"))
    fun integer(key: String, maximum: Int): Int {
        val value = data.get(key)
        require(value is Number && value.toDouble() % 1.0 == 0.0 && value.toDouble() in 0.0..maximum.toDouble())
        return value.toInt()
    }
    return PreviewSpacing(integer("sideMarginPercent", 200), integer("edgeClearancePercent", 200),
        integer("sectionGapDp", 80), integer("channelGapDp", 40), integer("pushGapDp", 48))
}

internal fun withLegacyPreviewSpacing(data: JSONObject): JSONObject {
    require(!data.has("spacing"))
    return JSONObject(data.toString()).put("spacing", PreviewSpacing().json())
}
