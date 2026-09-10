package com.arthack.agentvoice

import org.json.JSONObject
import java.util.Locale

internal data class PreviewHalo(
    val variant: String = "original",
    val containedSizePercent: Int = 78,
    val ringSpreadPercent: Int = 35,
    val listeningPulsePercent: Int = 25,
    val speakingMotionPercent: Int = 25,
    val idleBreathingPercent: Int = 25,
    val speakingColor: String = "#bbaaff",
    val listeningColor: String = "#d4ff72",
    val idleColor: String = "#f0f2e9",
) {
    init {
        require(variant in setOf("original", "contained"))
        require(containedSizePercent in 35..120)
        require(listOf(ringSpreadPercent, listeningPulsePercent, speakingMotionPercent, idleBreathingPercent).all { it in 0..100 })
        require(listOf(speakingColor, listeningColor, idleColor).all { it.matches(Regex("#[0-9a-f]{6}")) })
    }

    fun json(): JSONObject = JSONObject().put("variant", variant).put("containedSizePercent", containedSizePercent)
        .put("ringSpreadPercent", ringSpreadPercent).put("listeningPulsePercent", listeningPulsePercent)
        .put("speakingMotionPercent", speakingMotionPercent).put("idleBreathingPercent", idleBreathingPercent)
        .put("colors", JSONObject().put("speaking", speakingColor).put("listening", listeningColor).put("idle", idleColor))

    fun placement(original: PersonaPlacement): PersonaPlacement {
        val scale = containedSizePercent / 100f
        return original.copy(speakingScale = scale, listeningScale = scale, idleScale = scale)
    }

    fun tuning() = CompactHaloTuning(ringSpreadPercent, listeningPulsePercent, speakingMotionPercent, idleBreathingPercent)
    fun colors() = CompactHaloColors(argb(speakingColor), argb(listeningColor), argb(idleColor))
    private fun argb(value: String): Int = (0xff000000L or value.substring(1).toLong(16)).toInt()
}

internal fun decodePreviewHalo(data: JSONObject): PreviewHalo {
    require(data.fields() == setOf("variant", "containedSizePercent", "ringSpreadPercent", "listeningPulsePercent",
        "speakingMotionPercent", "idleBreathingPercent", "colors"))
    fun percent(key: String, minimum: Int = 0, maximum: Int = 100): Int {
        val value = data.get(key)
        require(value is Number && value.toDouble() % 1.0 == 0.0 && value.toDouble() in minimum.toDouble()..maximum.toDouble())
        return value.toInt()
    }
    val colors = data.getJSONObject("colors")
    require(colors.fields() == previewModes)
    fun color(key: String): String {
        val value = colors.get(key)
        require(value is String && value.matches(Regex("#[0-9a-fA-F]{6}")))
        return value.lowercase(Locale.ROOT)
    }
    return PreviewHalo(data.getString("variant"), percent("containedSizePercent", 35, 120), percent("ringSpreadPercent"),
        percent("listeningPulsePercent"), percent("speakingMotionPercent"), percent("idleBreathingPercent"),
        color("speaking"), color("listening"), color("idle"))
}

internal fun decodePersonaHalo(json: String): PreviewHalo {
    val data = JSONObject(json)
    return when (data.getInt("version")) {
        1, 2, 3, 4 -> PreviewHalo()
        5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 -> decodePreviewHalo(data.getJSONObject("halo"))
        else -> error("Unsupported Persona tuning version")
    }
}
