package com.arthack.agentvoice

import org.json.JSONObject

/** Route geometry and ambient light remain independent of Persona and control tuning. */
internal data class PreviewTraces(
    val pattern: String = "parallel",
    val stancePercent: Int = 100,
    val weightPercent: Int = 100,
    val offshootPercent: Int = 0,
    val glowPercent: Int = 0,
    val personaSpacingPercent: Int = 100,
    val footSpacingPercent: Int = 100,
) {
    init {
        require(pattern in setOf("parallel", "splayed", "circuit"))
        require(stancePercent in 75..150 && weightPercent in 50..250)
        require(offshootPercent in 0..100 && glowPercent in 0..100)
        require(personaSpacingPercent in 50..200 && footSpacingPercent in 50..200)
    }

    fun json(): JSONObject = JSONObject().put("pattern", pattern).put("stancePercent", stancePercent)
        .put("weightPercent", weightPercent).put("offshootPercent", offshootPercent).put("glowPercent", glowPercent)
        .put("personaSpacingPercent", personaSpacingPercent).put("footSpacingPercent", footSpacingPercent)
}

internal fun decodePreviewTraces(data: JSONObject): PreviewTraces {
    require(data.fields() == setOf("pattern", "stancePercent", "weightPercent", "offshootPercent", "glowPercent",
        "personaSpacingPercent", "footSpacingPercent"))
    fun percent(key: String, range: IntRange): Int {
        val value = data.get(key)
        require(value is Number && value.toDouble() % 1.0 == 0.0 && value.toDouble() in range.first.toDouble()..range.last.toDouble())
        return value.toInt()
    }
    return PreviewTraces(data.getString("pattern"), percent("stancePercent", 75..150), percent("weightPercent", 50..250),
        percent("offshootPercent", 0..100), percent("glowPercent", 0..100),
        percent("personaSpacingPercent", 50..200), percent("footSpacingPercent", 50..200))
}

internal fun migrateVersionNineTraces(data: JSONObject): JSONObject {
    require(data.fields() == setOf("pattern", "stancePercent", "weightPercent", "offshootPercent", "glowPercent"))
    return JSONObject(data.toString()).put("personaSpacingPercent", 100).put("footSpacingPercent", 100)
}
