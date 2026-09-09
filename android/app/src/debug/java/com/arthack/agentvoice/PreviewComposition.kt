package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
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

/** A split mechanical saddle. Its supports belong to the deck, never to animated Halo bounds. */
@Composable
internal fun PreviewPersonaSocket(
    stageHeight: Dp,
    controlsHeight: Dp,
    sideInset: Dp,
    modifier: Modifier = Modifier,
    personaCenterY: Dp = stageHeight / 2f,
    personaClearRadius: Dp = 0.dp,
) {
    Canvas(modifier) {
        val base = compositionBase(stageHeight, controlsHeight, sideInset) ?: return@Canvas
        val face = compositionInk(VoiceInk.surface.copy(alpha = .95f), personaCenterY, personaClearRadius)
        val edge = compositionInk(VoiceInk.line.copy(alpha = .88f), personaCenterY, personaClearRadius)
        val bevel = compositionInk(VoiceInk.muted.copy(alpha = .32f), personaCenterY, personaClearRadius)
        val inner = minOf(12.dp.toPx(), base.reach * .16f)
        val outer = minOf(42.dp.toPx(), base.reach * .56f)
        val corner = minOf(6.dp.toPx(), (outer - inner) / 3f, base.rise * .12f)
        val footHalf = minOf(22.dp.toPx(), base.channelWidth * .18f)
        val saddle = base.deckTop - base.rise * .46f
        val footTop = base.deckTop - minOf(12.dp.toPx(), base.rise * .22f)

        clipRect(top = base.top, bottom = base.end) {
            repeat(2) { side ->
                val sign = if (side == 0) -1f else 1f
                fun x(distance: Float) = base.center + sign * distance
                val support = Path().apply {
                    moveTo(x(outer), base.top + corner)
                    lineTo(x(outer - corner), base.top)
                    lineTo(x(inner), base.top)
                    lineTo(x(inner), base.top + base.rise * .22f)
                    lineTo(x(outer - corner), saddle)
                    lineTo(x(base.reach - footHalf), footTop)
                    lineTo(x(base.reach - footHalf), base.end)
                    lineTo(x(base.reach + footHalf), base.end)
                    lineTo(x(base.reach + footHalf), footTop)
                    lineTo(x(outer + corner), saddle - corner)
                    close()
                }
                drawPath(support, face)
                drawPath(support, edge, style = Stroke(1.dp.toPx(), join = StrokeJoin.Bevel))
                drawLine(bevel,
                    Offset(x(outer - corner), base.top + 2.dp.toPx()),
                    Offset(x(inner + 2.dp.toPx()), base.top + 2.dp.toPx()),
                    strokeWidth = 1.5.dp.toPx(), cap = StrokeCap.Butt)
            }
        }
    }
}

/** Parallel board routes terminate in contacts; their empty middle stays open for the Persona. */
@Composable
internal fun PreviewPersonaTraces(
    stageHeight: Dp,
    controlsHeight: Dp,
    sideInset: Dp,
    modifier: Modifier = Modifier,
    personaCenterY: Dp = stageHeight / 2f,
    personaClearRadius: Dp = 0.dp,
) {
    Canvas(modifier) {
        val base = compositionBase(stageHeight, controlsHeight, sideInset) ?: return@Canvas
        val route = compositionInk(VoiceInk.line.copy(alpha = .84f), personaCenterY, personaClearRadius)
        val contact = compositionInk(VoiceInk.muted.copy(alpha = .32f), personaCenterY, personaClearRadius)
        val verticalScale = base.rise / 56.dp.toPx()
        val lane = minOf(8.dp.toPx(), base.reach * .12f)
        val firstContact = minOf(18.dp.toPx(), base.reach * .24f)
        val diagonal = minOf(16.dp.toPx() * verticalScale, base.reach * .2f)
        val padWidth = minOf(4.dp.toPx(), lane / 2f)

        clipRect(top = base.top, bottom = base.end) {
            repeat(2) { side ->
                val sign = if (side == 0) -1f else 1f
                fun x(distance: Float) = base.center + sign * distance
                repeat(2) { index ->
                    val upper = firstContact + index * lane
                    val lower = base.reach + (index - .5f) * lane
                    val contactTop = base.top + 1.dp.toPx() * verticalScale
                    val contactBottom = base.top + 8.dp.toPx() * verticalScale
                    // Outer routes turn earlier, so neither trace crosses the other's landing.
                    val turn = base.deckTop - (30 + index * 8).dp.toPx() * verticalScale
                    val trace = Path().apply {
                        moveTo(x(upper), contactBottom)
                        lineTo(x(upper), turn)
                        lineTo(x(upper + diagonal), turn + diagonal)
                        lineTo(x(lower), turn + diagonal)
                        lineTo(x(lower), base.end)
                    }
                    drawPath(trace, route, style = Stroke(1.2.dp.toPx(), cap = StrokeCap.Butt, join = StrokeJoin.Bevel))
                    drawRect(contact, Offset(x(upper) - padWidth / 2f, contactTop),
                        Size(padWidth, contactBottom - contactTop))
                    drawRect(contact, Offset(x(lower) - padWidth / 2f, base.deckTop - 4.dp.toPx() * verticalScale),
                        Size(padWidth, minOf(5.dp.toPx() * verticalScale, base.end - base.deckTop + 4.dp.toPx() * verticalScale)))
                }
            }
        }
    }
}

private data class CompositionBase(
    val center: Float,
    val reach: Float,
    val channelWidth: Float,
    val deckTop: Float,
    val top: Float,
    val rise: Float,
    val end: Float,
)

private fun DrawScope.compositionBase(stageHeight: Dp, controlsHeight: Dp, sideInset: Dp): CompositionBase? {
    val deckTop = stageHeight.toPx()
    val deckBottom = (stageHeight + controlsHeight).toPx()
    val inset = sideInset.toPx()
    if (!deckTop.isFinite() || !deckBottom.isFinite() || !inset.isFinite()) return null
    val channelWidth = (size.width - inset.coerceAtLeast(0f) * 2 - 10.dp.toPx()) / 2f
    val end = minOf(deckTop + 4.dp.toPx(), deckBottom, size.height)
    if (deckTop <= 0f || end <= deckTop || channelWidth <= 0f) return null
    val center = size.width / 2f
    val reach = center - (inset.coerceAtLeast(0f) + channelWidth / 2f)
    val rise = minOf(56.dp.toPx(), deckTop)
    return CompositionBase(center, reach, channelWidth, deckTop, deckTop - rise, rise, end)
}

private fun DrawScope.compositionInk(color: Color, personaCenterY: Dp, personaClearRadius: Dp): Brush {
    val centerY = personaCenterY.toPx()
    val clearRadius = personaClearRadius.toPx()
    if (!centerY.isFinite() || !clearRadius.isFinite()) return SolidColor(Color.Transparent)
    if (clearRadius <= 0f) return SolidColor(color)
    val outerRadius = clearRadius + 12.dp.toPx()
    // Alpha belongs to each support, rather than painting or outlining a circular mask.
    // The static clear disk stays empty; a soft edge avoids a second ring around the Halo.
    return Brush.radialGradient(
        0f to color.copy(alpha = 0f),
        clearRadius / outerRadius to color.copy(alpha = 0f),
        1f to color,
        center = Offset(size.width / 2f, centerY),
        radius = outerRadius,
    )
}
