package com.arthack.agentvoice

import org.json.JSONObject

internal val previewActivities = setOf("steady", "voice")

/** Experimental light is independent of the operator's geometry, motion and base palette. */
internal data class PreviewSpirit(
    val surface: String = "still",
    val strengthPercent: Int = 35,
    val persona: String = "fixed",
) {
    init {
        require(surface in setOf("still", "soft"))
        require(strengthPercent in 0..100)
        require(persona in setOf("fixed", "follow"))
    }

    fun json(): JSONObject = JSONObject().put("surface", surface).put("strengthPercent", strengthPercent).put("persona", persona)
}

internal fun decodePreviewSpirit(data: JSONObject): PreviewSpirit {
    require(data.fields() == setOf("surface", "strengthPercent", "persona"))
    val strength = data.get("strengthPercent")
    require(strength is Number && strength.toDouble() % 1.0 == 0.0 && strength.toDouble() in 0.0..100.0)
    return PreviewSpirit(data.getString("surface"), strength.toInt(), data.getString("persona"))
}

internal fun decodePersonaSpirit(json: String): PreviewSpirit {
    val data = JSONObject(json)
    return when (data.getInt("version")) {
        1, 2, 3, 4, 5, 6 -> PreviewSpirit()
        7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 -> decodePreviewSpirit(data.getJSONObject("spirit"))
        else -> error("Unsupported Persona tuning version")
    }
}
