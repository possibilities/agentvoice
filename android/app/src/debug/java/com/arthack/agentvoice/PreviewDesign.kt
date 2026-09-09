package com.arthack.agentvoice

import org.json.JSONObject

internal data class PreviewDesign(
    val layout: String = "original",
    val header: String = "quiet",
    val mute: String = "glyphs",
    val hold: String = "beam",
) {
    fun json(): JSONObject = JSONObject().put("layout", layout).put("header", header).put("mute", mute).put("hold", hold)
}

internal fun decodePreviewDesign(data: JSONObject): PreviewDesign {
    require(data.fields() == setOf("layout", "header", "mute", "hold"))
    val layout = data.getString("layout")
    val header = data.getString("header")
    val mute = data.getString("mute")
    val hold = data.getString("hold")
    require(layout in setOf("original", "studio") && header in setOf("quiet", "drawer", "none") &&
        mute in setOf("glyphs", "rockers", "keycaps") && hold in setOf("beam", "trigger", "keycap"))
    return PreviewDesign(layout, header, mute, hold)
}

internal fun decodePersonaDesign(json: String): PreviewDesign {
    val data = JSONObject(json)
    return when (data.getInt("version")) {
        1, 2 -> PreviewDesign()
        3 -> decodePreviewDesign(data.getJSONObject("design"))
        else -> error("Unsupported Persona tuning version")
    }
}
