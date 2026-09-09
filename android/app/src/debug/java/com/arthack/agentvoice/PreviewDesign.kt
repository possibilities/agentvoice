package com.arthack.agentvoice

import org.json.JSONObject

internal data class PreviewDesign(
    val layout: String = "studio",
    val header: String = "none",
    val mute: String = "keycaps",
    val hold: String = "trigger",
    val controlsHeightDp: Int = 262,
    val holdSharePercent: Double = 116.0 / 262.0 * 100.0,
) {
    fun json(): JSONObject = JSONObject().put("layout", layout).put("header", header).put("mute", mute).put("hold", hold)
        .put("controlsHeightDp", controlsHeightDp).put("holdSharePercent", holdSharePercent)
}

internal fun decodePreviewDesign(data: JSONObject): PreviewDesign {
    require(data.fields() == setOf("layout", "header", "mute", "hold", "controlsHeightDp", "holdSharePercent"))
    require(data.getString("layout") == "studio" && data.getString("header") == "none" && data.getString("hold") == "trigger")
    val mute = data.getString("mute")
    require(mute in setOf("rockers", "keycaps"))
    val height = data.get("controlsHeightDp")
    val share = data.get("holdSharePercent")
    require(height is Number && height.toDouble() % 1.0 == 0.0 && height.toDouble() in 240.0..480.0)
    require(share is Number && share.toDouble().isFinite() && share.toDouble() in 30.0..60.0)
    return PreviewDesign(mute = mute, controlsHeightDp = height.toInt(), holdSharePercent = share.toDouble())
}

internal fun decodePersonaDesign(json: String): PreviewDesign {
    val data = JSONObject(json)
    return when (data.getInt("version")) {
        1, 2 -> PreviewDesign()
        // Retired directions load into the chosen header and hold, without rewriting the saved file.
        3 -> {
            val old = data.getJSONObject("design")
            require(old.fields() == setOf("layout", "header", "mute", "hold"))
            require(old.getString("layout") in setOf("original", "studio") &&
                old.getString("header") in setOf("quiet", "drawer", "none") &&
                old.getString("mute") in setOf("glyphs", "rockers", "keycaps") &&
                old.getString("hold") in setOf("beam", "trigger", "keycap"))
            PreviewDesign(mute = if (old.getString("mute") == "rockers") "rockers" else "keycaps")
        }
        4 -> decodePreviewDesign(data.getJSONObject("design"))
        else -> error("Unsupported Persona tuning version")
    }
}
