package com.arthack.agentvoice

import androidx.compose.runtime.Immutable
import org.json.JSONObject

@Immutable
internal data class PreviewMutedTuning(
    val textSizeSp: Int = 14,
    val brightnessPercent: Int = 0,
    val driftPercent: Int = 100,
    val breathPercent: Int = 0,
    val cycleSeconds: Int = 14,
    val motion: String = "float",
) {
    init {
        require(textSizeSp in 12..32)
        require(brightnessPercent in -100..100)
        require(driftPercent in 0..300)
        require(breathPercent in 0..100)
        require(cycleSeconds in 6..30)
        require(motion in setOf("float", "ripple"))
    }

    fun json(): JSONObject = JSONObject().put("textSizeSp", textSizeSp)
        .put("brightnessPercent", brightnessPercent).put("driftPercent", driftPercent)
        .put("breathPercent", breathPercent).put("cycleSeconds", cycleSeconds).put("motion", motion)
}

internal fun decodePreviewMutedTuning(data: JSONObject): PreviewMutedTuning {
    require(data.fields() == setOf("textSizeSp", "brightnessPercent", "driftPercent", "breathPercent", "cycleSeconds", "motion"))
    fun integer(key: String, range: IntRange): Int {
        val value = data.get(key)
        require(value is Number)
        val number = value.toDouble()
        require(number.isFinite() && number % 1.0 == 0.0 && number >= range.first && number <= range.last)
        return number.toInt()
    }
    val motion = data.get("motion")
    require(motion is String && motion in setOf("float", "ripple"))
    return PreviewMutedTuning(integer("textSizeSp", 12..32), integer("brightnessPercent", -100..100),
        integer("driftPercent", 0..300), integer("breathPercent", 0..100), integer("cycleSeconds", 6..30), motion)
}
