package com.arthack.agentvoice

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

internal data class PreviewMutedPresenceFit(
    val driftXPx: Float,
    val driftYPx: Float,
    val rippleYPx: Float = 0f,
    val breathScale: Float = 0f,
)

/** All dimensions are pixels; [unit] is the number of pixels in one dp. */
internal fun previewMutedPresenceFit(
    textWidthPx: Float,
    textHeightPx: Float,
    innerRadiusPx: Float,
    unit: Float = 1f,
    tuning: PreviewMutedTuning = PreviewMutedTuning(),
): PreviewMutedPresenceFit? {
    if (listOf(textWidthPx, textHeightPx, innerRadiusPx, unit).any { !it.isFinite() || it <= 0f }) return null
    val halfWidth = textWidthPx.toDouble() / 2.0
    val halfHeight = textHeightPx.toDouble() / 2.0
    val radius = innerRadiusPx.toDouble() - 8.0 * unit
    val stillSquared = halfWidth * halfWidth + halfHeight * halfHeight
    if (radius <= 0.0 || stillSquared > radius * radius) return null

    val drift = tuning.driftPercent / 100.0
    val driftX = unit * drift
    val driftY = 3.0 * unit * drift
    val rippleY = if (tuning.motion == "ripple") 2.0 * unit * drift else 0.0
    val breathScale = .03 * tuning.breathPercent / 100.0
    val growthX = driftX + halfWidth * breathScale
    val growthY = driftY + rippleY + halfHeight * breathScale
    // This rectangle contains every tide phase without sampling native animation frames.
    val fullSquared = (halfWidth + growthX) * (halfWidth + growthX) +
        (halfHeight + growthY) * (halfHeight + growthY)
    fun fitted(amount: Double) = PreviewMutedPresenceFit((driftX * amount).toFloat(), (driftY * amount).toFloat(),
        (rippleY * amount).toFloat(), (breathScale * amount).toFloat())
    if (fullSquared <= radius * radius) return fitted(1.0)

    val available = radius * radius - stillSquared
    val projection = halfWidth * growthX + halfHeight * growthY
    val driftSquared = growthX * growthX + growthY * growthY
    val amount = (available / (sqrt(projection * projection + driftSquared * available) + projection))
        .coerceIn(0.0, 1.0)
    return fitted(amount)
}

internal data class PreviewMutedPresenceFrame(
    val offsetX: Float = 0f,
    val offsetY: Float = 0f,
    val scale: Float = 1f,
    val alpha: Float = .84f,
    val glyphOffsets: List<Float> = emptyList(),
)

/** [phase] is already integrated by the scene at the selected cycle duration. */
internal fun previewMutedPresenceFrame(
    phase: Float,
    motionAllowed: Boolean,
    fit: PreviewMutedPresenceFit,
    tuning: PreviewMutedTuning = PreviewMutedTuning(),
): PreviewMutedPresenceFrame {
    val dim = 1f + minOf(tuning.brightnessPercent, 0) / 100f
    val baseAlpha = .84f + .16f * (maxOf(tuning.brightnessPercent, 0) / 100f)
    if (!motionAllowed || !phase.isFinite()) return PreviewMutedPresenceFrame(alpha = baseAlpha * dim)
    val angle = (phase.toDouble() % 1.0) * 2.0 * PI
    val breath = ((1.0 - cos(angle)) / 2.0).toFloat()
    val excursion = .15f * (tuning.breathPercent / 100f)
    // Breathing never makes an otherwise readable word dimmer than the original treatment.
    val alpha = if (excursion == 0f) baseAlpha else {
        val low = (baseAlpha - excursion / 2f).coerceIn(.84f, 1f - excursion)
        low + excursion * breath
    }
    return PreviewMutedPresenceFrame(
        offsetX = fit.driftXPx * sin(angle).toFloat(),
        offsetY = fit.driftYPx * cos(angle).toFloat(),
        scale = 1f + fit.breathScale * breath,
        alpha = alpha * dim,
        glyphOffsets = if (tuning.motion == "ripple" && fit.rippleYPx > 0f)
            List(5) { fit.rippleYPx * sin(angle - it * .8).toFloat() } else emptyList(),
    )
}

/** The caller owns gate truth, lifecycle and the shared clock; this layer owns no input. */
@Composable
internal fun PreviewMutedPresence(
    eligible: Boolean,
    motionAllowed: Boolean,
    phase: State<Float>,
    stageDiameter: Dp,
    offsetY: Dp,
    innerRadius: Dp,
    modifier: Modifier = Modifier,
    ink: Color = VoiceInk.muted,
    tuning: PreviewMutedTuning = PreviewMutedTuning(),
    primaryInk: Color = VoiceInk.text,
) {
    if (!eligible || !stageDiameter.value.isFinite() || stageDiameter <= 0.dp || !offsetY.value.isFinite()) return
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val style = remember(tuning.textSizeSp) {
        TextStyle(fontFamily = VoiceInk.type, fontSize = tuning.textSizeSp.sp, fontWeight = FontWeight.Normal,
            letterSpacing = .02f.em, lineHeight = (tuning.textSizeSp * 18f / 14f).sp)
    }
    val text = remember(measurer, density, style) {
        measurer.measure("muted", style, maxLines = 1, softWrap = false)
    }
    val fit = remember(text.size, innerRadius, density, tuning) {
        previewMutedPresenceFit(text.size.width.toFloat(), text.size.height.toFloat(),
            with(density) { innerRadius.toPx() }, density.density, tuning)
    } ?: return
    val tint = when (maxOf(tuning.brightnessPercent, 0)) {
        0 -> ink
        100 -> primaryInk
        else -> lerp(ink, primaryInk, tuning.brightnessPercent / 100f)
    }
    val entrance = remember { Animatable(if (motionAllowed) 0f else 1f) }
    LaunchedEffect(motionAllowed) {
        if (motionAllowed) entrance.animateTo(1f, tween(450, easing = LinearOutSlowInEasing))
        else entrance.snapTo(1f)
    }
    Canvas(modifier.requiredSize(stageDiameter).testTag("preview-muted-presence").clearAndSetSemantics { }) {
        val frame = previewMutedPresenceFrame(if (motionAllowed) phase.value else 0f, motionAllowed, fit, tuning)
        val arrival = if (motionAllowed) entrance.value else 1f
        val color = tint.copy(alpha = frame.alpha * arrival)
        val origin = Offset((size.width - text.size.width) / 2f + frame.offsetX,
            (size.height - text.size.height) / 2f + offsetY.toPx() + frame.offsetY)
        val center = origin + Offset(text.size.width / 2f, text.size.height / 2f)
        fun drawWord() {
            if (frame.glyphOffsets.isEmpty()) {
                drawText(text, color = color, topLeft = origin)
            } else {
                for (index in frame.glyphOffsets.indices) {
                    val glyph = text.getBoundingBox(index)
                    // Slice the same shaped word; compensating for scale keeps wave travel within its fitted envelope.
                    val waveY = frame.glyphOffsets[index] / frame.scale
                    clipRect(left = origin.x + glyph.left, right = origin.x + glyph.right,
                        top = origin.y + waveY - 1f, bottom = origin.y + waveY + text.size.height + 1f) {
                        drawText(text, color = color, topLeft = origin + Offset(0f, waveY))
                    }
                }
            }
        }
        if (frame.scale == 1f) drawWord() else scale(frame.scale, frame.scale, center) { drawWord() }
    }
}
