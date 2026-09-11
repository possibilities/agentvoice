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
    val launcher: String = "current",
    val connectionStyle: String = "relay",
) {
    init {
        require(launcher in previewLaunchers)
        require(connectionStyle in previewConnectionStyles)
        require(theme in previewThemes && mutedPresence in previewMutedPresences && presenceScope in previewPresenceScopes)
    }
    fun json() = JSONObject().put("theme", theme).put("mutedPresence", mutedPresence)
        .put("mutedTuning", mutedTuning.json()).put("presenceScope", presenceScope)
        .put("showPushToTalk", showPushToTalk).put("icons", icons.json()).put("launcher", launcher)
        .put("connectionStyle", connectionStyle)
}

internal fun shippingAppearance() = DesignAppearance(ShippingDesign.theme, ShippingDesign.mutedPresence,
    ShippingDesign.mutedTuning, ShippingDesign.presenceScope, ShippingDesign.showPushToTalk, ShippingDesign.icons,
    ShippingDesign.launcher, ShippingDesign.connectionStyle)

internal val previewLaunchers = setOf("current", "duplex-halo", "relay-aperture", "voice-carrier")
internal val previewConnectionStyles = setOf("relay", "beacon", "datum")

internal fun decodeDesignAppearance(data: JSONObject, legacy: Boolean = false,
    legacyConnectionStyle: Boolean = legacy): DesignAppearance {
    require(data.fields() == setOf("theme", "mutedPresence", "mutedTuning", "presenceScope", "showPushToTalk", "icons") +
        (if (legacy) emptySet<String>() else setOf("launcher")) +
        (if (legacyConnectionStyle) emptySet<String>() else setOf("connectionStyle")))
    return DesignAppearance(data.getString("theme"), data.getString("mutedPresence"),
        decodePreviewMutedTuning(data.getJSONObject("mutedTuning")), data.getString("presenceScope"),
        data.get("showPushToTalk").also { require(it is Boolean) } as Boolean,
        decodePreviewIcons(data.getJSONObject("icons")), if (legacy) "current" else data.getString("launcher"),
        if (legacyConnectionStyle) "relay" else data.getString("connectionStyle"))
}

internal fun decodeDesignAppearanceProfile(json: String): DesignAppearance {
    val data = JSONObject(json)
    require(data.getInt("version") in 1..23)
    if (data.getInt("version") < 19) return DesignAppearance()
    val values = JSONObject()
    val legacyLauncher = data.getInt("version") == 19
    val legacyConnectionStyle = data.getInt("version") <= 21
    for (key in DesignAppearance().json().fields())
        if ((!legacyLauncher || key != "launcher") && (!legacyConnectionStyle || key != "connectionStyle"))
            values.put(key, data.get(key))
    return decodeDesignAppearance(values, legacyLauncher, legacyConnectionStyle)
}
