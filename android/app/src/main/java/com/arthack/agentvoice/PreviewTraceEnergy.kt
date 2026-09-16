package com.arthack.agentvoice

import androidx.compose.runtime.State
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.acos

/** Routes are ordered Persona -> control, independent of physical orientation or handedness. */
internal fun previewTraceFlowAt(position: Float, phaseTurns: Float, channel: PreviewTraceChannel): Float {
    if (!position.isFinite() || position !in 0f..1f || !phaseTurns.isFinite()) return 0f
    val travel = if (channel == PreviewTraceChannel.Capture) 1f - position else position
    // Enter and leave beyond the endpoints so wrapping never teleports a visible head.
    val center = (phaseTurns - kotlin.math.floor(phaseTurns)) * 1.6f - .3f
    val distance = (travel - center) / .3f
    return if (distance <= -1f || distance >= 1f) 0f else (.5f + .5f * cos(distance * PI).toFloat())
}

internal fun PreviewButtonLight.traceEnergy(channel: PreviewTraceChannel, ui: CallUi): Float {
    if (!ui.connected || ui.controlsPending) return 0f
    val level = when (channel) {
        PreviewTraceChannel.Capture -> if (ui.micOpen) captureEnergy else 0f
        PreviewTraceChannel.Playback -> if (ui.speakerOpen) playbackEnergy else 0f
    }
    return if (level.isFinite()) level.coerceIn(0f, 1f) else 0f
}

/** A narrow overlay on the existing path, with the same clear-center feather as the static ink. */
internal fun DrawScope.drawPreviewTraceEnergy(
    path: Path,
    channel: PreviewTraceChannel,
    strokeWidth: Float,
    center: Offset,
    join: PreviewTraceJoin,
    theme: PreviewTheme,
    light: State<PreviewButtonLight>?,
    ui: CallUi,
    enabled: Boolean,
) {
    if (!enabled || light == null) return
    val frame = light.value // Draw-phase observation: never recompose controls or move a held pointer.
    val energy = frame.traceEnergy(channel, ui)
    if (energy <= .001f) return
    val ink = if (channel == PreviewTraceChannel.Capture) VoiceInk.you else VoiceInk.agent
    val brush = previewTraceInk(theme.decoration(ink.copy(alpha = .42f * energy)), center, join)
    val measure = PathMeasure().apply { setPath(path, false) }
    if (!measure.length.isFinite() || measure.length <= 0f) return
    val segment = Path()
    val travel = (frame.flowPhaseTurns - kotlin.math.floor(frame.flowPhaseTurns)) * 1.6f - .3f
    val position = if (channel == PreviewTraceChannel.Capture) 1f - travel else travel
    // Nested, continuous paths approximate the soft cosine band. They avoid raster seams
    // between short samples and bound work to twelve paths and one feather brush per route.
    for (halfWidth in traceEnergyBandWidths) {
        val start = (position - halfWidth).coerceIn(0f, 1f)
        val end = (position + halfWidth).coerceIn(0f, 1f)
        if (end <= start) continue
        segment.reset()
        measure.getSegment(start * measure.length, end * measure.length, segment)
        drawPath(segment, brush, alpha = 1f / traceEnergyBandWidths.size,
            style = Stroke(strokeWidth, cap = StrokeCap.Butt, join = StrokeJoin.Bevel))
    }
}

private val traceEnergyBandWidths = List(12) { index ->
    val intensity = (index + .5f) / 12f
    .3f * acos(2f * intensity - 1f) / PI.toFloat()
}
