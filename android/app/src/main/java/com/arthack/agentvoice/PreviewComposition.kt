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
    channelGapDp: Int = 10,
) {
    val theme = LocalPreviewTheme.current
    Canvas(modifier) {
        val join = previewTraceJoin(personaClearRadius.toPx(), 1.dp.toPx(), settings) ?: return@Canvas
        val geometry = previewTraceGeometry(size.width, size.height, stageHeight.toPx(), controlsHeight.toPx(),
            sideInset.toPx(), personaCenterY.toPx(), join.radiusPx, 1.dp.toPx(), settings, channelGapDp) ?: return@Canvas
        val center = Offset(size.width / 2f, personaCenterY.toPx())
        val route = previewTraceInk(theme.decoration(VoiceInk.line.copy(alpha = .84f)), center, join)
        val contact = previewTraceInk(theme.decoration(VoiceInk.muted.copy(alpha = .32f)), center, join)
        clipRect(bottom = geometry.endY) {
            for (trace in geometry.routes) {
                drawPath(trace.points.tracePath(), route,
                    style = Stroke(geometry.strokeWidth, cap = StrokeCap.Butt, join = StrokeJoin.Bevel))
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

internal fun previewTraceInk(color: Color, center: Offset, join: PreviewTraceJoin): Brush {
    if (!center.x.isFinite() || !center.y.isFinite()) return SolidColor(Color.Transparent)
    if (join.outerRadiusPx == 0f) return SolidColor(color)
    val stops = join.opacityStops().map { (position, opacity) -> position to color.copy(alpha = color.alpha * opacity) }
    return Brush.radialGradient(*stops.toTypedArray(), center = center, radius = join.outerRadiusPx)
}
