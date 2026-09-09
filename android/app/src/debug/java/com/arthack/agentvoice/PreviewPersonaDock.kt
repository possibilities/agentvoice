package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** A shared material behind Persona and its controls; it owns no layout or interaction. */
@Composable
internal fun PreviewPersonaDock(
    stageHeight: Dp,
    controlsHeight: Dp,
    sideInset: Dp,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val left = sideInset.toPx().coerceAtLeast(0f)
        val right = size.width - left
        val top = (stageHeight.toPx() * .44f).coerceAtLeast(0f)
        val bottom = (stageHeight + controlsHeight).toPx().coerceAtMost(size.height)
        if (right <= left || bottom <= top) return@Canvas

        val cut = minOf(10.dp.toPx(), (right - left) / 4f, (bottom - top) / 4f)
        val plate = Path().apply {
            moveTo(left + cut, top)
            lineTo(right - cut, top)
            lineTo(right, top + cut)
            lineTo(right, bottom - cut)
            lineTo(right - cut, bottom)
            lineTo(left + cut, bottom)
            lineTo(left, bottom - cut)
            lineTo(left, top + cut)
            close()
        }
        drawPath(plate, Brush.verticalGradient(
            0f to Color.Transparent,
            .28f to VoiceInk.surface.copy(alpha = .35f),
            .6f to VoiceInk.surface.copy(alpha = .62f),
            1f to VoiceInk.surface.copy(alpha = .62f),
            startY = top, endY = bottom,
        ))

        // The open upper edge lets the full-bleed Halo cross the material without a frame.
        val shoulders = Path().apply {
            moveTo(left + cut, top)
            lineTo(left, top + cut)
            lineTo(left, bottom - cut)
            lineTo(left + cut, bottom)
            lineTo(right - cut, bottom)
            lineTo(right, bottom - cut)
            lineTo(right, top + cut)
            lineTo(right - cut, top)
        }
        drawPath(shoulders, Brush.verticalGradient(
            0f to Color.Transparent,
            .25f to VoiceInk.line.copy(alpha = .2f),
            .65f to VoiceInk.line.copy(alpha = .5f),
            1f to VoiceInk.line.copy(alpha = .5f),
            startY = top, endY = bottom,
        ), style = Stroke(width = 1.dp.toPx(), join = StrokeJoin.Bevel))
    }
}
