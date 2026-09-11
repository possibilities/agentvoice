package com.arthack.agentvoice

import androidx.compose.runtime.staticCompositionLocalOf
import org.json.JSONObject

internal val previewPushIcons = setOf("current", "contact", "microphone")
internal val previewIconFamilies = setOf("current", "engraved", "phosphor-bold", "phosphor-fill", "noun-boatman", "noun-icons", "participant-profile", "participant-bold", "participant-fill")

/** Shared icon choices persist with the complete design profile; release bundles only its selection. */
internal data class PreviewIcons(val channels: String = "current", val push: String = "current") {
    init { require(channels in previewIconFamilies && push in previewPushIcons) }
    fun json(): JSONObject = JSONObject().put("channels", channels).put("push", push)
}

internal fun decodePreviewIcons(data: JSONObject): PreviewIcons {
    require(data.fields() == setOf("channels", "push"))
    return PreviewIcons(data.getString("channels"), data.getString("push"))
}

internal val LocalPreviewIcons = staticCompositionLocalOf { PreviewIcons() }
