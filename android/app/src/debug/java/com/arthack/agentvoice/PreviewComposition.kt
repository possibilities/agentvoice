package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Board routes meet the allocated Persona aperture; native glow remains in its own foreground layer. */
@Composable
internal fun PreviewPersonaTraces(
    stageHeight: Dp,
    controlsHeight: Dp,
    sideInset: Dp,
    modifier: Modifier = Modifier,
    personaCenterY: Dp = stageHeight / 2f,
    personaClearRadius: Dp = 0.dp,
    settings: PreviewTraces = PreviewTraces(),
) {
    Canvas(modifier) {
        val geometry = previewTraceGeometry(size.width, size.height, stageHeight.toPx(), controlsHeight.toPx(),
            sideInset.toPx(), personaCenterY.toPx(), personaClearRadius.toPx(), 1.dp.toPx(), settings) ?: return@Canvas
        val route = compositionInk(VoiceInk.line.copy(alpha = .84f), personaCenterY, personaClearRadius)
        val contact = compositionInk(VoiceInk.muted.copy(alpha = .32f), personaCenterY, personaClearRadius)
        clipRect(bottom = geometry.endY) {
            if (settings.offshootPercent > 0) {
                val offshoot = compositionInk(VoiceInk.line.copy(alpha = .28f * settings.offshootPercent.coerceIn(0, 100) / 100f),
                    personaCenterY, personaClearRadius)
                for (points in geometry.offshoots) drawPath(points.tracePath(), offshoot,
                    style = Stroke(maxOf(.45.dp.toPx(), geometry.strokeWidth * .62f),
                        cap = StrokeCap.Butt, join = StrokeJoin.Bevel))
            }
            for (trace in geometry.routes) {
                drawPath(trace.points.tracePath(), route,
                    style = Stroke(geometry.strokeWidth, cap = StrokeCap.Butt, join = StrokeJoin.Bevel))
                drawLine(contact, trace.port.offset(), trace.contactEnd.offset(), geometry.contactWidth, StrokeCap.Butt)
                drawLine(contact, Offset(trace.landing.x, maxOf(trace.contactEnd.y, geometry.deckTop - 4.dp.toPx())),
                    trace.landing.offset(), geometry.contactWidth, StrokeCap.Butt)
            }
        }
    }
}

private fun PreviewTracePoint.offset() = Offset(x, y)

private fun List<PreviewTracePoint>.tracePath() = Path().apply {
    firstOrNull()?.let { moveTo(it.x, it.y) }
    for (point in drop(1)) lineTo(point.x, point.y)
}

private fun DrawScope.compositionInk(color: Color, personaCenterY: Dp, personaClearRadius: Dp): Brush {
    val centerY = personaCenterY.toPx()
    val clearRadius = personaClearRadius.toPx()
    if (!centerY.isFinite() || !clearRadius.isFinite()) return SolidColor(Color.Transparent)
    if (clearRadius <= 0f) return SolidColor(color)
    val outerRadius = clearRadius + 12.dp.toPx()
    // Alpha belongs only to the routes. The transparent disk never clips or repaints native Halo pixels.
    return Brush.radialGradient(
        0f to color.copy(alpha = 0f),
        clearRadius / outerRadius to color.copy(alpha = 0f),
        1f to color,
        center = Offset(size.width / 2f, centerY),
        radius = outerRadius,
    )
}
