package com.arthack.agentvoice

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import org.json.JSONObject

internal val previewPushIcons = setOf("current", "contact", "microphone")
internal val previewIconFamilies = setOf("current", "engraved", "phosphor-bold", "phosphor-fill", "noun-boatman", "noun-icons")

/** Auditions belong to the preview session, never the saved operator profile. */
internal data class PreviewIcons(val channels: String = "current", val push: String = "current") {
    init { require(channels in previewIconFamilies && push in previewPushIcons) }
    fun json(): JSONObject = JSONObject().put("channels", channels).put("push", push)
}

internal fun decodePreviewIcons(data: JSONObject): PreviewIcons {
    require(data.fields() == setOf("channels", "push"))
    return PreviewIcons(data.getString("channels"), data.getString("push"))
}

internal val LocalPreviewIcons = staticCompositionLocalOf { PreviewIcons() }

@Composable
internal fun previewChannelPainter(speaker: Boolean, muted: Boolean): Painter? {
    val resource = when (LocalPreviewIcons.current.channels) {
        "engraved" -> if (speaker) {
            if (muted) R.drawable.preview_engraved_speaker_muted else R.drawable.preview_engraved_speaker
        } else {
            if (muted) R.drawable.preview_engraved_mic_muted else R.drawable.preview_engraved_mic
        }
        "phosphor-bold" -> if (speaker) {
            if (muted) R.drawable.preview_phosphor_speaker_slash_bold else R.drawable.preview_phosphor_speaker_high_bold
        } else {
            if (muted) R.drawable.preview_phosphor_microphone_slash_bold else R.drawable.preview_phosphor_microphone_bold
        }
        "phosphor-fill" -> if (speaker) {
            if (muted) R.drawable.preview_phosphor_speaker_slash_fill else R.drawable.preview_phosphor_speaker_high_fill
        } else {
            if (muted) R.drawable.preview_phosphor_microphone_slash_fill else R.drawable.preview_phosphor_microphone_fill
        }
        "noun-boatman" -> if (speaker) {
            if (muted) R.drawable.preview_noun_boatman_speaker_muted else R.drawable.preview_noun_boatman_speaker
        } else {
            if (muted) R.drawable.preview_noun_boatman_mic_muted else R.drawable.preview_noun_boatman_mic
        }
        "noun-icons" -> if (speaker) {
            if (muted) R.drawable.preview_noun_icons_speaker_muted else R.drawable.preview_noun_icons_speaker
        } else {
            if (muted) R.drawable.preview_noun_icons_mic_muted else R.drawable.preview_noun_icons_mic
        }
        else -> return null
    }
    return painterResource(resource)
}

