package com.arthack.agentvoice

import org.json.JSONObject

internal data class PreviewDesign(
    val layout: String = "studio",
    val header: String = "none",
    val controlsHeightDp: Int = 262,
    val holdSharePercent: Double = 116.0 / 262.0 * 100.0,
    val traces: PreviewTraces = PreviewTraces(),
    val spacing: PreviewSpacing = PreviewSpacing(),
    val controlsWithoutPttDp: Int = controlsHeightDp,
) {
    fun controlsExtent(showPushToTalk: Boolean) = if (showPushToTalk) controlsHeightDp else controlsWithoutPttDp
    val mute: String = "rockers"
    val hold: String = "rocker"
    val composition: String = "traces"
    fun json(): JSONObject = JSONObject().put("layout", layout).put("header", header).put("mute", mute).put("hold", hold)
        .put("composition", composition)
        .put("controlsHeightDp", controlsHeightDp).put("holdSharePercent", holdSharePercent).put("traces", traces.json())
        .put("spacing", spacing.json()).put("controlsWithoutPttDp", controlsWithoutPttDp)
}

internal fun decodePreviewDesign(data: JSONObject): PreviewDesign {
    require(data.fields() == setOf("layout", "header", "mute", "hold", "composition", "controlsHeightDp", "holdSharePercent", "traces", "spacing", "controlsWithoutPttDp"))
    require(data.getString("layout") == "studio" && data.getString("header") == "none")
    require(data.getString("mute") == "rockers" && data.getString("hold") == "rocker")
    require(data.getString("composition") == "traces")
    val height = data.get("controlsHeightDp")
    val hidden = data.get("controlsWithoutPttDp")
    val share = data.get("holdSharePercent")
    require(height is Number && height.toDouble() % 1.0 == 0.0 && height.toDouble() in 160.0..1600.0)
    require(hidden is Number && hidden.toDouble() % 1.0 == 0.0 && hidden.toDouble() in 160.0..1600.0)
    require(share is Number && share.toDouble().isFinite() && share.toDouble() in 30.0..60.0)
    return PreviewDesign(controlsHeightDp = height.toInt(), holdSharePercent = share.toDouble(),
        traces = decodePreviewTraces(data.getJSONObject("traces")), spacing = decodePreviewSpacing(data.getJSONObject("spacing")), controlsWithoutPttDp = hidden.toInt())
}

private fun decodeLegacyStudioDesign(data: JSONObject, version: Int): PreviewDesign {
    require(data.fields() == setOf("layout", "header", "mute", "hold", "composition", "controlsHeightDp", "holdSharePercent"))
    require(data.getString("mute") in if (version == 8) setOf("rockers") else setOf("rockers", "keycaps"))
    require(data.getString("hold") in if (version == 8) setOf("rocker") else setOf("trigger", "rocker"))
    require(data.getString("composition") in if (version <= 6) setOf("open", "dock", "yoke") else setOf("open", "dock", "yoke", "socket", "traces"))
    // Old shapes are validated before migration; loading never publishes a profile.
    return decodeLegacyControlExtentDesign(withLegacyPreviewSpacing(data.put("mute", "rockers").put("hold", "rocker")
        .put("composition", "traces").put("traces", PreviewTraces().json())))
}

internal fun decodePersonaDesign(json: String): PreviewDesign {
    val data = JSONObject(json)
    return when (data.getInt("version")) {
        1, 2 -> PreviewDesign()
        // Retired directions retain compatible geometry and use the selected Rockers.
        3 -> {
            val old = data.getJSONObject("design")
            require(old.fields() == setOf("layout", "header", "mute", "hold"))
            require(old.getString("layout") in setOf("original", "studio") &&
                old.getString("header") in setOf("quiet", "drawer", "none") &&
                old.getString("mute") in setOf("glyphs", "rockers", "keycaps") &&
                old.getString("hold") in setOf("beam", "trigger", "keycap"))
            PreviewDesign()
        }
        4, 5 -> {
            val old = data.getJSONObject("design")
            require(old.fields() == setOf("layout", "header", "mute", "hold", "controlsHeightDp", "holdSharePercent"))
            require(old.getString("hold") == "trigger")
            decodeLegacyStudioDesign(old.put("composition", "open"), data.getInt("version"))
        }
        6, 7, 8 -> decodeLegacyStudioDesign(data.getJSONObject("design"), data.getInt("version"))
        9 -> {
            val design = data.getJSONObject("design")
            require(design.fields() == setOf("layout", "header", "mute", "hold", "composition", "controlsHeightDp", "holdSharePercent", "traces"))
            val migrated = JSONObject(design.toString()).put("traces", migrateVersionNineTraces(design.getJSONObject("traces")))
            decodeLegacyControlExtentDesign(withLegacyTraceJoin(withLegacyPreviewSpacing(migrated)))
        }
        10, 11 -> decodeLegacyControlExtentDesign(withLegacyTraceJoin(withLegacyPreviewSpacing(data.getJSONObject("design"))))
        12 -> decodeLegacyControlExtentDesign(withLegacyTraceJoin(withVersionTwelvePadding(data.getJSONObject("design"))))
        13 -> decodeLegacyControlExtentDesign(withLegacyTraceJoin(data.getJSONObject("design")))
        14, 15, 16 -> decodeLegacyControlExtentDesign(withoutLegacyOffshoots(data.getJSONObject("design")))
        17 -> decodeLegacyControlExtentDesign(data.getJSONObject("design"))
        18, 19, 20, 21, 22 -> decodePreviewDesign(data.getJSONObject("design"))
        else -> error("Unsupported Persona tuning version")
    }
}

internal fun withoutLegacyOffshoots(design: JSONObject): JSONObject =
    JSONObject(design.toString()).put("traces", stripLegacyOffshoots(design.getJSONObject("traces")))

/** Old files have one bounded extent; seed both modes without writing the file. */
internal fun decodeLegacyControlExtentDesign(data: JSONObject): PreviewDesign {
    require(!data.has("controlsWithoutPttDp"))
    val extent = data.get("controlsHeightDp")
    require(extent is Number && extent.toDouble() % 1.0 == 0.0 && extent.toDouble() in 240.0..480.0)
    return decodePreviewDesign(JSONObject(data.toString()).put("controlsWithoutPttDp", extent))
}
