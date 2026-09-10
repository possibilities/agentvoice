package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.State
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.scale
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

@Immutable
internal data class PreviewAmbientFrame(val phaseTurns: Float = 0f, val amount: Float = 0f)

@Immutable
internal data class PreviewAmbientLobe(
    val centerX: Float,
    val centerY: Float,
    val radiusX: Float,
    val radiusY: Float,
    val alpha: Float,
    val tint: Int,
)

internal val previewAmbientFeatherStops: List<Pair<Float, Float>> = List(9) { index ->
    val radius = index / 8f
    radius to (1f - radius * radius * (3f - 2f * radius))
}

/** Normalized fields never depend on measured controls, the Halo, or channel activity. */
internal fun previewAmbientLobes(frame: PreviewAmbientFrame): List<PreviewAmbientLobe> {
    val amount = if (frame.amount.isFinite()) frame.amount.coerceIn(0f, 1f) else 0f
    if (amount == 0f) return emptyList()
    val remainder = if (frame.phaseTurns.isFinite()) frame.phaseTurns % 1f else 0f
    val phase = if (remainder < 0f) remainder + 1f else remainder
    val angle = phase.toDouble() * 2.0 * PI
    val wave = sin(angle).toFloat()
    val drift = cos(angle).toFloat()
    val breath = (1f - drift) / 2f
    val swell = 1f + .06f * wave
    val settle = 1f - .06f * wave
    // Full native tints stay perceptible; even overlapping peaks sum to at most .128 alpha.
    return listOf(
        PreviewAmbientLobe(.25f + .03f * wave, .59f + .03f * drift,
            .74f * swell, .56f * swell, amount * (.052f + .036f * breath), 0xFFD4FF72.toInt()),
        PreviewAmbientLobe(.78f - .03f * wave, .34f - .03f * drift,
            .78f * settle, .64f * settle, amount * (.064f - .024f * breath), 0xFFBBAAFF.toInt()),
    )
}

@Composable
internal fun PreviewAmbientGlow(frame: State<PreviewAmbientFrame>, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        if (!size.width.isFinite() || !size.height.isFinite() || size.width <= 0f || size.height <= 0f) return@Canvas
        // Draw-phase observation keeps shared clock ticks out of layout, input, and native identity.
        val lobes = previewAmbientLobes(frame.value)
        clipRect {
            for (lobe in lobes) {
                val center = Offset(size.width * lobe.centerX, size.height * lobe.centerY)
                val radius = size.width * lobe.radiusX
                val stretch = size.height * lobe.radiusY / radius
                if (!stretch.isFinite() || stretch <= 0f) continue
                val color = Color(lobe.tint)
                val stops = previewAmbientFeatherStops.map { (position, weight) ->
                    position to color.copy(alpha = lobe.alpha * weight)
                }.toTypedArray()
                val brush = Brush.radialGradient(*stops, center = center, radius = radius)
                scale(scaleX = 1f, scaleY = stretch, pivot = center) {
                    drawCircle(brush, radius = radius, center = center)
                }
            }
        }
    }
}
