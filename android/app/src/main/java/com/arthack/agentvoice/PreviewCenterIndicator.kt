package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

private data class CenterText(
    val layout: TextLayoutResult,
    val origin: Offset,
    val atom: Int,
    val channel: PreviewCenterChannel? = null,
)

private data class CenterGlyph(
    val channel: PreviewCenterChannel,
    val origin: Offset,
    val sizePx: Float,
    val atom: Int,
)

private data class CenterDrawing(
    val widthPx: Float,
    val heightPx: Float,
    val texts: List<CenterText> = emptyList(),
    val glyphs: List<CenterGlyph> = emptyList(),
    val atoms: Int,
)

/** This decorative layer owns no input or clock and never retains an earlier gate assertion. */
@Composable
internal fun PreviewCenterIndicator(
    ui: CallUi,
    style: String,
    scope: String,
    foreground: Boolean,
    motionAllowed: Boolean,
    phase: State<Float>,
    stageDiameter: Dp,
    offsetY: Dp,
    innerRadius: Dp,
    tuning: PreviewMutedTuning,
    modifier: Modifier = Modifier,
) {
    val model = previewCenterIndicatorModel(ui, style, scope, foreground) ?: return
    if (!stageDiameter.value.isFinite() || stageDiameter <= 0.dp || !offsetY.value.isFinite()) return
    val channelPainters = listOf(previewChannelPainter(false, false), previewChannelPainter(false, true),
        previewChannelPainter(true, false), previewChannelPainter(true, true))
    val density = LocalDensity.current
    val theme = LocalPreviewTheme.current
    val measurer = rememberTextMeasurer()
    val presentation = remember(model, density, measurer, innerRadius, tuning) {
        val radiusPx = with(density) { innerRadius.toPx() }
        // Reserve the longest two-line status so opening a channel cannot enlarge the type.
        val envelope = if (model.style == "words") model.copy(words = listOf("human", "muted")) else model
        (tuning.textSizeSp downTo 12).firstNotNullOfOrNull { size ->
            val textStyle = TextStyle(fontFamily = VoiceInk.type, fontSize = size.sp, fontWeight = FontWeight.Normal,
                letterSpacing = .02f.em, lineHeight = (size * 1.18f).sp)
            val reserved = centerDrawing(envelope, measurer, textStyle, density)
            val fit = previewMutedPresenceFit(reserved.widthPx, reserved.heightPx, radiusPx, density.density, tuning)
            if (fit == null) null else centerDrawing(model, measurer, textStyle, density) to fit
        }
    } ?: return
    val (drawing, fit) = presentation
    val inks = remember(theme, tuning.brightnessPercent) {
        val ground = theme.palette.ground
        val light = theme.foreground(VoiceInk.text, ground, opacity = .82f)
        val lift = maxOf(tuning.brightnessPercent, 0) / 100f
        fun ink(base: Color) = lerp(theme.foreground(base, ground, opacity = .6888f), light, lift)
        listOf(ink(VoiceInk.muted), ink(lerp(VoiceInk.muted, VoiceInk.you, .65f)),
            ink(lerp(VoiceInk.muted, VoiceInk.agent, .65f)))
    }
    Canvas(modifier.requiredSize(stageDiameter).testTag("preview-center-indicator").clearAndSetSemantics { }) {
        val frame = previewCenterIndicatorFrame(if (motionAllowed) phase.value else 0f, motionAllowed, fit,
            tuning, drawing.atoms)
        val origin = Offset((size.width - drawing.widthPx) / 2f + frame.offsetX,
            (size.height - drawing.heightPx) / 2f + offsetY.toPx() + frame.offsetY)
        val center = origin + Offset(drawing.widthPx / 2f, drawing.heightPx / 2f)
        fun ink(channel: PreviewCenterChannel?): Color {
            val index = when {
                channel == null || !channel.open -> 0
                channel.kind == PreviewCenterChannelKind.Human -> 1
                else -> 2
            }
            return inks[index].copy(alpha = inks[index].alpha * frame.alpha * .82f)
        }
        fun wave(atom: Int): Float = frame.glyphOffsets.getOrElse(atom) { 0f } / frame.scale
        fun drawContent() {
            for (text in drawing.texts) {
                val position = origin + text.origin
                val color = ink(text.channel)
                if (frame.glyphOffsets.isEmpty()) {
                    drawText(text.layout, color = color, topLeft = position)
                } else {
                    for (index in text.layout.layoutInput.text.text.indices) {
                        val glyph = text.layout.getBoundingBox(index)
                        val shift = wave(text.atom + index)
                        clipRect(left = position.x + glyph.left, right = position.x + glyph.right,
                            top = position.y + shift - 1f, bottom = position.y + shift + text.layout.size.height + 1f) {
                            drawText(text.layout, color = color, topLeft = position + Offset(0f, shift))
                        }
                    }
                }
            }
            for (glyph in drawing.glyphs) {
                val position = origin + glyph.origin + Offset(0f, wave(glyph.atom))
                if (model.style == "contacts") {
                    drawCenterContact(glyph.channel.open, position, glyph.sizePx, ink(glyph.channel))
                } else {
                    val painter = channelPainters[(if (glyph.channel.kind == PreviewCenterChannelKind.Agent) 2 else 0) +
                        if (glyph.channel.open) 0 else 1]
                    if (painter == null) drawCenterChannel(glyph.channel, position, glyph.sizePx, ink(glyph.channel))
                    else translate(position.x, position.y) {
                        with(painter) { draw(Size(glyph.sizePx, glyph.sizePx), colorFilter = ColorFilter.tint(ink(glyph.channel))) }
                    }
                }
            }
        }
        if (frame.scale == 1f) drawContent() else scale(frame.scale, frame.scale, center) { drawContent() }
    }
}

private fun centerDrawing(model: PreviewCenterIndicatorModel, measurer: TextMeasurer,
    style: TextStyle, density: Density): CenterDrawing {
    fun measure(text: String) = measurer.measure(text, style, maxLines = 1, softWrap = false)
    val fontSize = with(density) { style.fontSize.toPx() }
    val unit = density.density
    return when (model.style) {
        "words" -> {
            val lines = model.words.map(::measure)
            val width = lines.maxOf { it.size.width }.toFloat()
            val gap = 2f * unit
            val height = lines.sumOf { it.size.height }.toFloat() + (lines.size - 1) * gap
            var y = 0f
            var atom = 0
            val texts = lines.map { line ->
                CenterText(line, Offset((width - line.size.width) / 2f, y), atom).also {
                    y += line.size.height + gap
                    atom += line.layoutInput.text.length
                }
            }
            CenterDrawing(width, height, texts = texts, atoms = atom)
        }
        "labeled" -> {
            val labels = mapOf("live" to measure("live"), "muted" to measure("muted"))
            val glyphSize = maxOf(12f * unit, fontSize * .7f)
            val gap = 6f * unit
            val rowGap = 4f * unit
            // Reserve both labels so a gate change cannot slide either channel's glyph or text column.
            val textWidth = labels.values.maxOf { it.size.width }.toFloat()
            val rowHeight = maxOf(glyphSize, labels.values.maxOf { it.size.height }.toFloat())
            var atom = 0
            val glyphs = mutableListOf<CenterGlyph>()
            val texts = model.channels.mapIndexed { row, channel ->
                val y = row * (rowHeight + rowGap)
                glyphs += CenterGlyph(channel, Offset(0f, y + (rowHeight - glyphSize) / 2f), glyphSize, atom++)
                val label = labels.getValue(channel.label)
                CenterText(label, Offset(glyphSize + gap, y + (rowHeight - label.size.height) / 2f),
                    atom, channel).also { atom += label.layoutInput.text.length }
            }
            CenterDrawing(glyphSize + gap + textWidth, rowHeight * 2f + rowGap, texts, glyphs, atom)
        }
        "contacts" -> {
            val width = 1.91f * fontSize
            val height = .35f * fontSize
            val glyphs = model.channels.mapIndexed { index, channel ->
                CenterGlyph(channel, Offset((.355f + index * 1.2f) * fontSize, .28f * fontSize), fontSize, index)
            }
            CenterDrawing(width, height, glyphs = glyphs, atoms = glyphs.size)
        }
        else -> {
            val glyphSize = fontSize * 1.25f
            val gap = 12f * unit
            val glyphs = model.channels.mapIndexed { index, channel ->
                CenterGlyph(channel, Offset(index * (glyphSize + gap), 0f), glyphSize, index)
            }
            CenterDrawing(glyphSize * 2f + gap, glyphSize, glyphs = glyphs, atoms = glyphs.size)
        }
    }
}

private fun DrawScope.drawCenterChannel(channel: PreviewCenterChannel, origin: Offset, extent: Float, ink: Color) {
    val unit = extent / 24f
    val stroke = maxOf(1.dp.toPx() / unit, 1.45f)
    translate(origin.x, origin.y) {
        scale(unit, unit, Offset.Zero) {
            if (channel.kind == PreviewCenterChannelKind.Human) {
                drawRoundRect(ink, Offset(9f, 3f), Size(6f, 11f), CornerRadius(3f), style = Stroke(stroke))
                drawPath(Path().apply {
                    moveTo(6.5f, 11.5f); lineTo(6.5f, 13f)
                    cubicTo(6.5f, 20f, 17.5f, 20f, 17.5f, 13f); lineTo(17.5f, 11.5f)
                }, ink, style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round))
                drawLine(ink, Offset(12f, 18.2f), Offset(12f, 21f), stroke, StrokeCap.Round)
                drawLine(ink, Offset(9f, 21f), Offset(15f, 21f), stroke, StrokeCap.Round)
            } else {
                drawPath(Path().apply {
                    moveTo(3.5f, 9f); lineTo(8f, 9f); lineTo(13f, 5f)
                    lineTo(13f, 19f); lineTo(8f, 15f); lineTo(3.5f, 15f); close()
                }, ink, style = Stroke(stroke, join = StrokeJoin.Round))
                if (channel.open) {
                    drawPath(Path().apply {
                        moveTo(17f, 8.5f); cubicTo(20f, 10f, 20f, 14f, 17f, 15.5f)
                    }, ink, style = Stroke(stroke, cap = StrokeCap.Round))
                }
            }
            if (!channel.open) drawLine(ink, Offset(4f, 3.5f), Offset(20f, 20.5f),
                stroke * 1.12f, StrokeCap.Round)
        }
    }
}

private fun DrawScope.drawCenterContact(open: Boolean, center: Offset, extent: Float, ink: Color) {
    val left = center + Offset(-.30f * extent, 0f)
    val right = center + Offset(.30f * extent, 0f)
    val stroke = maxOf(1.dp.toPx(), .045f * extent)
    drawCircle(ink, .055f * extent, left)
    drawCircle(ink, .055f * extent, right)
    drawLine(ink, left, if (open) right else center + Offset(.12f * extent, -.22f * extent),
        stroke, StrokeCap.Round)
}
