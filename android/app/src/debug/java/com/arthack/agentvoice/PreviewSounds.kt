package com.arthack.agentvoice

import org.json.JSONObject

internal val previewSoundFamilies = setOf("off", "rocker-29", "rocker-13")

/** Sound selection is shared by both orientations and persisted only by explicit Save. */
internal data class PreviewSounds(
    val family: String = "off",
    val volumePercent: Int = 70,
) {
    init {
        require(family in previewSoundFamilies)
        require(volumePercent in 0..100)
    }

    fun json(): JSONObject = JSONObject().put("family", family).put("volumePercent", volumePercent)
}

internal fun decodePreviewSounds(data: JSONObject): PreviewSounds {
    require(data.fields() == setOf("family", "volumePercent"))
    val family = data.get("family")
    val volume = data.get("volumePercent")
    require(family is String && family in previewSoundFamilies)
    require(volume is Number && volume.toDouble() % 1.0 == 0.0 && volume.toDouble() in 0.0..100.0)
    return PreviewSounds(family, volume.toInt())
}

internal fun decodePersonaSounds(json: String): PreviewSounds {
    val data = JSONObject(json)
    return when (data.getInt("version")) {
        in 1..15 -> PreviewSounds()
        16, 17 -> decodePreviewSounds(data.getJSONObject("sounds"))
        else -> error("Unsupported Persona tuning version")
    }
}
