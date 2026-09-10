package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Portrait routes turn onto the stacked mute faces; no route wraps around the control deck. */
@Composable
internal fun PreviewLandscapeTraces(
    geometry: PreviewOrientationGeometry,
    clearRadius: Dp,
    design: PreviewDesign,
    modifier: Modifier = Modifier,
) {
    val theme = LocalPreviewTheme.current
    Canvas(modifier) {
        val unit = 1.dp.toPx()
        val join = previewTraceJoin(clearRadius.toPx(), unit, design.traces) ?: return@Canvas
        val traces = previewLandscapeTraceGeometry(geometry, size.width, unit, join.radiusPx,
            design.traces, design.spacing.effectiveChannelGapDp) ?: return@Canvas
        val center = Offset(traces.center.x, traces.center.y)
        val routeInk = previewTraceInk(theme.decoration(VoiceInk.line.copy(alpha = .84f)), center, join)
        val contactInk = previewTraceInk(theme.decoration(VoiceInk.muted.copy(alpha = .32f)), center, join)
        for (route in traces.routes) {
            val path = Path().apply {
                route.points.firstOrNull()?.let { moveTo(it.x, it.y) }
                for (point in route.points.drop(1)) lineTo(point.x, point.y)
            }
            drawPath(path, routeInk,
                style = Stroke(traces.strokeWidth, cap = StrokeCap.Butt, join = StrokeJoin.Bevel))
            val contactX = if (geometry.personaSide == "right")
                minOf(route.contactEnd.x, traces.deckEdgeX + 4f * unit)
            else maxOf(route.contactEnd.x, traces.deckEdgeX - 4f * unit)
            drawLine(contactInk, Offset(contactX, route.landing.y), Offset(route.landing.x, route.landing.y),
                traces.contactWidth, StrokeCap.Butt)
        }
    }
}
