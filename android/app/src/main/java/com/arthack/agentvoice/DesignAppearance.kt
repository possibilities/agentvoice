package com.arthack.agentvoice

import org.json.JSONObject

/** Durable visual choices; connection, gates and rehearsal activity are intentionally absent. */
internal data class DesignAppearance(
    val theme: String = "bright",
    val mutedPresence: String = "tide",
    val mutedTuning: PreviewMutedTuning = PreviewMutedTuning(),
    val presenceScope: String = "any-muted",
    val showPushToTalk: Boolean = true,
    val icons: PreviewIcons = PreviewIcons(),
) {
    init {
        require(theme in previewThemes && mutedPresence in previewMutedPresences && presenceScope in previewPresenceScopes)
    }
    fun json() = JSONObject().put("theme", theme).put("mutedPresence", mutedPresence)
        .put("mutedTuning", mutedTuning.json()).put("presenceScope", presenceScope)
        .put("showPushToTalk", showPushToTalk).put("icons", icons.json())
}

internal fun shippingAppearance() = DesignAppearance(ShippingDesign.theme, ShippingDesign.mutedPresence,
    ShippingDesign.mutedTuning, ShippingDesign.presenceScope, ShippingDesign.showPushToTalk, ShippingDesign.icons)

internal fun decodeDesignAppearance(data: JSONObject): DesignAppearance {
    require(data.fields() == setOf("theme", "mutedPresence", "mutedTuning", "presenceScope", "showPushToTalk", "icons"))
    return DesignAppearance(data.getString("theme"), data.getString("mutedPresence"),
        decodePreviewMutedTuning(data.getJSONObject("mutedTuning")), data.getString("presenceScope"),
        data.get("showPushToTalk").also { require(it is Boolean) } as Boolean,
        decodePreviewIcons(data.getJSONObject("icons")))
}

internal fun decodeDesignAppearanceProfile(json: String): DesignAppearance {
    val data = JSONObject(json)
    require(data.getInt("version") in 1..19)
    if (data.getInt("version") < 19) return DesignAppearance()
    val values = JSONObject()
    for (key in DesignAppearance().json().fields()) values.put(key, data.get(key))
    return decodeDesignAppearance(values)
}
