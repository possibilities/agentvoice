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

internal data class PreviewMutedPresenceFit(val driftXPx: Float, val driftYPx: Float)

/** All dimensions are pixels; [unit] is the number of pixels in one dp. */
internal fun previewMutedPresenceFit(
    textWidthPx: Float,
    textHeightPx: Float,
    innerRadiusPx: Float,
    unit: Float = 1f,
): PreviewMutedPresenceFit? {
    if (listOf(textWidthPx, textHeightPx, innerRadiusPx, unit).any { !it.isFinite() || it <= 0f }) return null
    val halfWidth = textWidthPx.toDouble() / 2.0
    val halfHeight = textHeightPx.toDouble() / 2.0
    val radius = innerRadiusPx.toDouble() - 8.0 * unit
    val stillSquared = halfWidth * halfWidth + halfHeight * halfHeight
    if (radius <= 0.0 || stillSquared > radius * radius) return null

    val driftX = unit.toDouble()
    val driftY = 3.0 * unit
    // This rectangle contains every tide phase without sampling native animation frames.
    val fullSquared = (halfWidth + driftX) * (halfWidth + driftX) +
        (halfHeight + driftY) * (halfHeight + driftY)
    if (fullSquared <= radius * radius) return PreviewMutedPresenceFit(driftX.toFloat(), driftY.toFloat())

    val available = radius * radius - stillSquared
    val projection = halfWidth * driftX + halfHeight * driftY
    val driftSquared = driftX * driftX + driftY * driftY
    val amount = (available / (sqrt(projection * projection + driftSquared * available) + projection))
        .coerceIn(0.0, 1.0)
    return PreviewMutedPresenceFit((driftX * amount).toFloat(), (driftY * amount).toFloat())
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
) {
    if (!eligible || !stageDiameter.value.isFinite() || stageDiameter <= 0.dp || !offsetY.value.isFinite()) return
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val style = remember {
        TextStyle(fontFamily = VoiceInk.type, fontSize = 14.sp, fontWeight = FontWeight.Normal,
            letterSpacing = .02f.em, lineHeight = 18.sp)
    }
    val text = remember(measurer, density, style) {
        measurer.measure("muted", style, maxLines = 1, softWrap = false)
    }
    val fit = remember(text.size, innerRadius, density) {
        previewMutedPresenceFit(text.size.width.toFloat(), text.size.height.toFloat(),
            with(density) { innerRadius.toPx() }, density.density)
    } ?: return
    val entrance = remember { Animatable(if (motionAllowed) 0f else 1f) }
    LaunchedEffect(motionAllowed) {
        if (motionAllowed) entrance.animateTo(1f, tween(450, easing = LinearOutSlowInEasing))
        else entrance.snapTo(1f)
    }
    Canvas(modifier.requiredSize(stageDiameter).testTag("preview-muted-presence").clearAndSetSemantics { }) {
        val currentPhase = if (motionAllowed) phase.value else 0f
        val moving = motionAllowed && currentPhase.isFinite()
        val angle = if (moving) (currentPhase.toDouble() % 1.0) * 2.0 * PI else 0.0
        val driftX = if (moving) fit.driftXPx * sin(angle).toFloat() else 0f
        val driftY = if (moving) fit.driftYPx * cos(angle).toFloat() else 0f
        val arrival = if (motionAllowed) entrance.value else 1f
        drawText(text, color = ink.copy(alpha = .84f * arrival), topLeft = Offset(
            (size.width - text.size.width) / 2f + driftX,
            (size.height - text.size.height) / 2f + offsetY.toPx() + driftY,
        ))
    }
}
