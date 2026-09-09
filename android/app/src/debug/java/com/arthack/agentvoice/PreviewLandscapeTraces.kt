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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.sqrt

/** Landscape routes enter the actual mute-row tops; the deck and native Halo keep their own layers. */
@Composable
internal fun PreviewLandscapeTraces(
    geometry: PreviewOrientationGeometry,
    clearRadius: Dp,
    design: PreviewDesign,
    deckScrollPixels: Int,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        // Scrolled-away top contacts must not draw across the now-visible button faces.
        if (deckScrollPixels > 0) return@Canvas
        val settings = design.traces
        val mirror = geometry.personaSide == "right"
        fun screenX(x: Float) = if (mirror) size.width - x else x
        val center = Offset((geometry.stageX + geometry.diameter / 2f).dp.toPx(),
            (geometry.stageY + geometry.diameter / 2f + geometry.offsetY).dp.toPx())
        val centerX = screenX(center.x)
        val deckX = if (mirror) size.width - (geometry.deckX + geometry.deckWidth).dp.toPx()
            else geometry.deckX.dp.toPx()
        val deckWidth = geometry.deckWidth.dp.toPx()
        val deckTop = geometry.deckY.dp.toPx()
        val radius = clearRadius.toPx()
        val gutter = deckX - (geometry.stageX.let {
            if (mirror) size.width - it.dp.toPx() else (it + geometry.diameter).dp.toPx()
        })
        val corridor = deckTop - 8.dp.toPx()
        if (radius <= 0f || corridor < 0f || gutter <= 0f) return@Canvas
        val stroke = 1.2.dp.toPx() * settings.weightPercent / 100f
        val outerRadius = radius + 12.dp.toPx()
        fun ink(alpha: Float) = Brush.radialGradient(
            0f to VoiceInk.line.copy(alpha = 0f),
            radius / outerRadius to VoiceInk.line.copy(alpha = 0f),
            1f to VoiceInk.line.copy(alpha = alpha), center = center, radius = outerRadius)
        val count = if (settings.pattern == "splayed") 3 else 2
        val footSpacing = 8.dp.toPx() * settings.footSpacingPercent / 100f
        val halfSpan = (count - 1) * footSpacing / 2f
        val channelWidth = (deckWidth - 10.dp.toPx()) / 2f
        val footMargin = minOf(channelWidth * .2f, 8.dp.toPx() + halfSpan)
        val reach = (deckWidth / 4f * settings.stancePercent / 100f)
            .coerceIn(5.dp.toPx() + footMargin, (deckWidth / 2f - footMargin).coerceAtLeast(5.dp.toPx() + footMargin))
        fun path(points: List<Offset>) = Path().apply {
            points.firstOrNull()?.let { moveTo(screenX(it.x), it.y) }
            for (point in points.drop(1)) lineTo(screenX(point.x), point.y)
        }
        for (channel in 0..1) for (lane in 0 until count) {
            val spread = (.22f + lane * .12f) * settings.personaSpacingPercent / 100f
            val yOffset = radius * spread.coerceAtMost(.8f) * if (channel == 0) 1f else -1f
            val port = Offset(centerX + sqrt((radius * radius - yOffset * yOffset).coerceAtLeast(0f)), center.y + yOffset)
            val footX = deckX + deckWidth / 2f + (if (channel == 0) -reach else reach) +
                (lane - (count - 1) / 2f) * footSpacing
            val routeX = deckX - gutter * (.28f + channel * .18f + lane * .07f)
            if (port.x >= routeX - 2.dp.toPx()) continue
            val routeY = corridor - (channel * count + lane) * 2.dp.toPx()
            if (routeY < 0f) continue
            val bend = minOf(6.dp.toPx(), (routeX - port.x) / 3f, (port.y - routeY).coerceAtLeast(0f) / 3f)
            val points = when (settings.pattern) {
                "splayed" -> listOf(port, Offset(routeX, routeY), Offset(footX, routeY), Offset(footX, deckTop + 4.dp.toPx()))
                "circuit" -> listOf(port, Offset(routeX - bend, port.y), Offset(routeX, port.y - bend),
                    Offset(routeX, routeY + bend), Offset(routeX + bend, routeY),
                    Offset(footX, routeY), Offset(footX, deckTop + 4.dp.toPx()))
                else -> listOf(port, Offset(routeX, port.y), Offset(routeX, routeY + bend),
                    Offset(routeX + bend, routeY), Offset(footX, routeY), Offset(footX, deckTop + 4.dp.toPx()))
            }
            drawPath(path(points), ink(.84f), style = Stroke(stroke, cap = StrokeCap.Butt, join = StrokeJoin.Bevel))
        }
        if (settings.offshootPercent > 0) {
            for (direction in listOf(-1f, 1f)) {
                val start = Offset(centerX - radius * .55f, center.y + direction * radius * .84f)
                val reachOut = minOf(18.dp.toPx(), (centerX - radius * .55f - 12.dp.toPx()).coerceAtLeast(0f))
                drawPath(path(listOf(start, Offset(start.x - reachOut, start.y + direction * reachOut),
                    Offset(start.x - reachOut * 1.4f, start.y + direction * reachOut))),
                    ink(.28f * settings.offshootPercent / 100f),
                    style = Stroke(maxOf(.45.dp.toPx(), stroke * .62f), join = StrokeJoin.Bevel))
            }
        }
    }
}
