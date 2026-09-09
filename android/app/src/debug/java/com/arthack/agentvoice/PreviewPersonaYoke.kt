package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Static structure behind the Persona and controls, independent of their media state. */
@Composable
internal fun PreviewPersonaYoke(
    stageHeight: Dp,
    controlsHeight: Dp,
    sideInset: Dp,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val deckTop = stageHeight.toPx().coerceIn(0f, size.height)
        val deckBottom = (stageHeight + controlsHeight).toPx().coerceIn(deckTop, size.height)
        val inset = sideInset.toPx().coerceAtLeast(0f)
        val channelWidth = (size.width - inset * 2 - 10.dp.toPx()) / 2f
        if (deckTop <= 0f || deckBottom <= deckTop || channelWidth <= 0f) return@Canvas

        val center = size.width / 2f
        val leftChannel = inset + channelWidth / 2f
        val rightChannel = size.width - leftChannel
        val rise = minOf(84.dp.toPx(), deckTop)
        val top = deckTop - rise
        val split = deckTop - minOf(30.dp.toPx(), rise * .45f)
        val shoulder = deckTop - minOf(15.dp.toPx(), rise * .23f)
        val end = minOf(deckTop + 4.dp.toPx(), deckBottom)
        val ink = VoiceInk.line.copy(alpha = .68f)
        val stroke = 1.dp.toPx()

        // Geometry belongs to the deck. Neither endpoint follows the animated ring,
        // and the controls cover the final few pixels of each arm.
        clipRect(top = top, bottom = end) {
            drawLine(Brush.verticalGradient(
                0f to ink.copy(alpha = 0f), .45f to ink, 1f to ink,
                startY = top, endY = split,
            ), start = Offset(center, top), end = Offset(center, split),
                strokeWidth = stroke, cap = StrokeCap.Butt)
            val fork = Path().apply {
                moveTo(leftChannel, end)
                cubicTo(leftChannel, shoulder, center, shoulder, center, split)
                cubicTo(center, shoulder, rightChannel, shoulder, rightChannel, end)
            }
            drawPath(fork, ink, style = Stroke(stroke, cap = StrokeCap.Butt, join = StrokeJoin.Round))
        }
    }
}
