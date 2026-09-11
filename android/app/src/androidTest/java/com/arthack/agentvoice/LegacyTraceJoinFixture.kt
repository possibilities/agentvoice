package com.arthack.agentvoice

import org.json.JSONArray
import org.json.JSONObject

/** Build historical fixtures from current encoders without leaking future schema fields. */
internal fun JSONObject.withoutTraceJoinFields(): JSONObject {
    withoutThinkingWingspan()
    withoutSharedAppearanceFields()
    for (key in listOf("reachDp", "fadeLengthDp", "tipOpacityPercent")) remove(key)
    for (key in fields()) optJSONObject(key)?.withoutTraceJoinFields()
    return this
}

internal fun JSONObject.withoutSharedAppearanceFields(): JSONObject {
    withoutThinkingWingspan()
    withLegacyOffshootFields()
    for (key in listOf("showPushToTalk", "sounds", "savedSounds", "defaultSounds", "horizontalOffsetDp", "appearanceOverrides", "sharedAppearance", "savedSharedAppearance",
        "defaultSharedAppearance", "savedHorizontalOffsetDp", "defaultHorizontalOffsetDp", "savedAppearanceOverrides")) remove(key)
    for (key in fields()) optJSONObject(key)?.withoutSharedAppearanceFields()
    return this
}

internal fun JSONObject.withLegacyOffshootFields(): JSONObject {
    withoutThinkingWingspan()
    remove("controlsWithoutPttDp")
    if (has("pattern") && has("stancePercent") && !has("offshootPercent")) put("offshootPercent", 0)
    for (key in fields()) optJSONObject(key)?.withLegacyOffshootFields()
    return this
}

internal fun JSONObject.withoutIndependentExtents(): JSONObject {
    withoutThinkingWingspan()
    remove("controlsWithoutPttDp")
    for (key in fields()) optJSONObject(key)?.withoutIndependentExtents()
    return this
}

internal fun JSONObject.withoutThinkingWingspan(): JSONObject {
    remove("thinkingWingspan")
    for (key in fields()) when (val value = opt(key)) {
        is JSONObject -> value.withoutThinkingWingspan()
        is JSONArray -> value.withoutThinkingWingspan()
    }
    return this
}

private fun JSONArray.withoutThinkingWingspan() {
    for (index in 0 until length()) when (val value = opt(index)) {
        is JSONObject -> value.withoutThinkingWingspan()
        is JSONArray -> value.withoutThinkingWingspan()
    }
}
