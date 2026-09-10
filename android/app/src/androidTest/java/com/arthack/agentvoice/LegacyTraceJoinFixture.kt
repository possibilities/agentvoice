package com.arthack.agentvoice

import org.json.JSONObject

/** Build historical fixtures from current encoders without leaking future schema fields. */
internal fun JSONObject.withoutTraceJoinFields(): JSONObject {
    withoutSharedAppearanceFields()
    for (key in listOf("reachDp", "fadeLengthDp", "tipOpacityPercent")) remove(key)
    for (key in fields()) optJSONObject(key)?.withoutTraceJoinFields()
    return this
}

internal fun JSONObject.withoutSharedAppearanceFields(): JSONObject {
    withLegacyOffshootFields()
    for (key in listOf("showPushToTalk", "sounds", "savedSounds", "defaultSounds", "horizontalOffsetDp", "appearanceOverrides", "sharedAppearance", "savedSharedAppearance",
        "defaultSharedAppearance", "savedHorizontalOffsetDp", "defaultHorizontalOffsetDp", "savedAppearanceOverrides")) remove(key)
    for (key in fields()) optJSONObject(key)?.withoutSharedAppearanceFields()
    return this
}

internal fun JSONObject.withLegacyOffshootFields(): JSONObject {
    if (has("pattern") && has("stancePercent") && !has("offshootPercent")) put("offshootPercent", 0)
    for (key in fields()) optJSONObject(key)?.withLegacyOffshootFields()
    return this
}
