package com.arthack.agentvoice

import org.json.JSONObject

/** Build historical fixtures from current encoders without leaking future schema fields. */
internal fun JSONObject.withoutTraceJoinFields(): JSONObject {
    for (key in listOf("reachDp", "fadeLengthDp", "tipOpacityPercent")) remove(key)
    for (key in fields()) optJSONObject(key)?.withoutTraceJoinFields()
    return this
}
