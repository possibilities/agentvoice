// Generated shipping icon provider.
package com.arthack.agentvoice

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource

@Composable
internal fun previewChannelPainter(speaker: Boolean, muted: Boolean): Painter? {
    if (LocalPreviewIcons.current.channels != "noun-icons") return null
    val resource = if (speaker) {
        if (muted) R.drawable.shipping_channel_speaker_muted else R.drawable.shipping_channel_speaker
    } else {
        if (muted) R.drawable.shipping_channel_mic_muted else R.drawable.shipping_channel_mic
    }
    return painterResource(resource)
}
