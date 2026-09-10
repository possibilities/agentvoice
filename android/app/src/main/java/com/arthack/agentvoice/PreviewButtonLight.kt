package com.arthack.agentvoice

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.State
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** Shared scene time and already-smoothed energy; zero amount preserves the unlit face exactly. */
@Immutable
internal data class PreviewButtonLight(
    val phaseTurns: Float = 0f,
    val amount: Float = 0f,
    val captureEnergy: Float = 0f,
    val playbackEnergy: Float = 0f,
)

internal fun DrawScope.drawPreviewButtonLight(
    face: Path,
    light: State<PreviewButtonLight>?,
    enabled: Boolean,
    capture: Boolean,
    ink: Color,
    strength: Float = 1f,
) {
    // Read the frame in the drawing phase only, and never retain activity after a gate closes.
    if (!enabled || light == null) return
    val frame = light.value
    val amount = frame.amount.lightUnit() * strength.lightUnit()
    if (amount == 0f) return
    val energy = (if (capture) frame.captureEnergy else frame.playbackEnergy).lightUnit()
    val alpha = (amount * (.010f + .025f * energy)).coerceAtMost(.035f)
    val angle = frame.phaseTurns.lightUnit().toDouble() * 2.0 * PI
    val center = Offset(
        size.width * (.5f + .18f * sin(angle).toFloat()),
        size.height * (.45f + .08f * cos(angle).toFloat()),
    )
    drawPath(face, Brush.radialGradient(
        0f to ink.copy(alpha = alpha),
        .55f to ink.copy(alpha = alpha * .3f),
        1f to ink.copy(alpha = 0f),
        center = center,
        radius = maxOf(size.width * .85f, size.height * 1.2f, 1f),
    ))
}

private fun Float.lightUnit(): Float = if (isFinite()) coerceIn(0f, 1f) else 0f
