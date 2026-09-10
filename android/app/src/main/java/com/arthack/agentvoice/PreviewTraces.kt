package com.arthack.agentvoice

import org.json.JSONObject

/** Route geometry and ambient light remain independent of Persona and control tuning. */
internal data class PreviewTraces(
    val pattern: String = "parallel",
    val stancePercent: Int = 100,
    val weightPercent: Int = 100,
    val glowPercent: Int = 0,
    val personaSpacingPercent: Int = 100,
    val footSpacingPercent: Int = 100,
    val reachDp: Int = 0,
    val fadeLengthDp: Int = 12,
    val tipOpacityPercent: Int = 0,
) {
    init {
        require(pattern in setOf("parallel", "splayed", "circuit"))
        require(stancePercent in 75..150 && weightPercent in 50..250)
        require(glowPercent in 0..100)
        require(personaSpacingPercent in 50..200 && footSpacingPercent in 50..200)
        require(reachDp in -40..120 && fadeLengthDp in 0..80 && tipOpacityPercent in 0..100)
    }

    fun json(): JSONObject = JSONObject().put("pattern", pattern).put("stancePercent", stancePercent)
        .put("weightPercent", weightPercent).put("glowPercent", glowPercent)
        .put("personaSpacingPercent", personaSpacingPercent).put("footSpacingPercent", footSpacingPercent)
        .put("reachDp", reachDp).put("fadeLengthDp", fadeLengthDp).put("tipOpacityPercent", tipOpacityPercent)
}

internal fun decodePreviewTraces(data: JSONObject): PreviewTraces {
    require(data.fields() == setOf("pattern", "stancePercent", "weightPercent", "glowPercent",
        "personaSpacingPercent", "footSpacingPercent", "reachDp", "fadeLengthDp", "tipOpacityPercent"))
    fun percent(key: String, range: IntRange): Int {
        val value = data.get(key)
        require(value is Number && value.toDouble() % 1.0 == 0.0 && value.toDouble() in range.first.toDouble()..range.last.toDouble())
        return value.toInt()
    }
    return PreviewTraces(data.getString("pattern"), percent("stancePercent", 75..150), percent("weightPercent", 50..250),
        percent("glowPercent", 0..100),
        percent("personaSpacingPercent", 50..200), percent("footSpacingPercent", 50..200),
        percent("reachDp", -40..120), percent("fadeLengthDp", 0..80), percent("tipOpacityPercent", 0..100))
}

internal fun migrateVersionNineTraces(data: JSONObject): JSONObject {
    require(data.fields() == setOf("pattern", "stancePercent", "weightPercent", "offshootPercent", "glowPercent"))
    return JSONObject(data.toString()).put("personaSpacingPercent", 100).put("footSpacingPercent", 100)
}

/** Validate the retired field before discarding it in memory; the saved bytes stay untouched. */
internal fun stripLegacyOffshoots(data: JSONObject): JSONObject {
    val value = data.get("offshootPercent")
    require(value is Number && value.toDouble() % 1.0 == 0.0 && value.toDouble() in 0.0..100.0)
    return JSONObject(data.toString()).apply { remove("offshootPercent") }
}

/** Validate the old shape before introducing join controls; loading never writes a profile. */
internal fun withLegacyTraceJoin(design: JSONObject): JSONObject {
    val traces = design.getJSONObject("traces")
    require(traces.fields() == setOf("pattern", "stancePercent", "weightPercent", "offshootPercent", "glowPercent",
        "personaSpacingPercent", "footSpacingPercent"))
    return JSONObject(design.toString()).put("traces", stripLegacyOffshoots(JSONObject(traces.toString())
        .put("reachDp", 0).put("fadeLengthDp", 12).put("tipOpacityPercent", 0)))
}
