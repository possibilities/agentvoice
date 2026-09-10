package com.arthack.agentvoice

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A read-only preview status. The parent owns its overlay placement and safe drawing insets. */
@Composable
internal fun PreviewConnectionNotice(connection: String, modifier: Modifier = Modifier) {
    require(connection == "connected" || connection == "connecting" || connection == "disconnected")
    val visibility = remember { MutableTransitionState(false) }
    visibility.targetState = connection != "connected"
    var lastNotice by remember { mutableStateOf(connection) }
    val displayedConnection = if (connection == "connected") lastNotice else connection
    // A resolved state removes the notice without changing its label during the exit.
    SideEffect { if (connection != "connected") lastNotice = connection }

    // Clipping keeps the sliding plate below the parent's safe top edge. Compose's
    // duration scale also applies to these transitions when Android disables motion.
    AnimatedVisibility(visibleState = visibility,
        modifier = modifier.fillMaxWidth().clipToBounds(),
        enter = slideInVertically(tween(240, easing = FastOutSlowInEasing), initialOffsetY = { -it }) + fadeIn(tween(160)),
        exit = slideOutVertically(tween(240, easing = FastOutSlowInEasing), targetOffsetY = { -it }) + fadeOut(tween(160))) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp), contentAlignment = Alignment.TopCenter) {
            val shape = CutCornerShape(bottomStart = 6.dp, bottomEnd = 6.dp)
            Row(Modifier.widthIn(min = 176.dp, max = 280.dp).heightIn(min = 36.dp)
                .background(VoiceInk.surface, shape).border(1.dp, VoiceInk.line, shape)
                .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
                .testTag("preview-connection-notice").padding(horizontal = 14.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally)) {
                ConnectionNoticeGlyph(displayedConnection == "disconnected")
                Text(if (displayedConnection == "disconnected") "Disconnected" else "Connecting…",
                    modifier = Modifier.testTag("preview-connection-label"), color = VoiceInk.text,
                    fontFamily = VoiceInk.type, fontSize = 12.sp, lineHeight = 16.sp, maxLines = 2)
            }
        }
    }
}

@Composable
private fun ConnectionNoticeGlyph(disconnected: Boolean) {
    Canvas(Modifier.size(14.dp).clearAndSetSemantics { }.testTag("preview-connection-glyph")) {
        fun point(x: Float, y: Float) = Offset(size.width * x, size.height * y)
        val stroke = 1.5.dp.toPx()
        drawLine(VoiceInk.muted, point(.05f, .5f), point(.28f, .5f), stroke, StrokeCap.Square)
        drawLine(VoiceInk.muted, point(.28f, .2f), point(.28f, .8f), stroke, StrokeCap.Square)
        drawLine(VoiceInk.muted, point(.72f, .2f), point(.72f, .8f), stroke, StrokeCap.Square)
        drawLine(VoiceInk.muted, point(.72f, .5f), point(.95f, .5f), stroke, StrokeCap.Square)
        if (disconnected) {
            drawLine(VoiceInk.text, point(.42f, .9f), point(.58f, .1f), stroke, StrokeCap.Square)
        } else {
            drawLine(VoiceInk.muted, point(.4f, .5f), point(.6f, .5f), stroke, StrokeCap.Square)
        }
    }
}
