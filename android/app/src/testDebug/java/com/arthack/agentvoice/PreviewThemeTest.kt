package com.arthack.agentvoice

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toArgb
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import org.junit.Assert.*
import org.junit.Test

class PreviewThemeTest {
    private val calm = listOf(PreviewTheme.Quiet, PreviewTheme.Grayscale)

    @Test fun brightPreservesArgbAndColorBitsWithoutRoundingOrContrastChanges() {
        val theme = PreviewTheme.Bright
        for (argb in listOf(0, 0x00E83791, 0x01020304, 0x7FC43182, 0xFEFDFCFB.toInt(), 0xFFFFFFFF.toInt())) {
            assertEquals(argb, theme.haloArgb(argb))
            assertBrightIdentity(Color(argb))
        }
        assertBrightIdentity(Color(.1f, .55f, .9f, .37f, ColorSpaces.DisplayP3))
        assertBrightIdentity(Color.Unspecified)
        assertEquals(listOf(VoiceInk.ground, VoiceInk.surface, VoiceInk.text, VoiceInk.muted,
            VoiceInk.line, VoiceInk.you, VoiceInk.agent), colors(theme.palette))
        assertEquals(1f, theme.decorationStrength)
    }

    @Test fun grayscaleHasEqualChannelsAndCustomAlphaSurvivesColorTransforms() {
        for (argb in listOf(0x00E83791, 0x31E83791, 0x80A954C7.toInt(), 0xFFF29E42.toInt())) {
            val source = Color(argb)
            for (theme in calm) {
                val transformed = listOf(theme.haloColor(source), theme.surface(source), theme.foreground(source))
                for (color in transformed) assertEquals(source.alpha, color.alpha, 0f)
                assertEquals(argb ushr 24, theme.haloArgb(argb) ushr 24)
                if (theme == PreviewTheme.Grayscale) for (color in transformed + theme.decoration(source)) {
                    assertEquals(color.red, color.green, 0f)
                    assertEquals(color.green, color.blue, 0f)
                }
            }
        }
        for (color in colors(PreviewTheme.Grayscale.palette)) {
            assertEquals(color.red, color.green, 0f)
            assertEquals(color.green, color.blue, 0f)
        }
        val wide = Color(.1f, .55f, .9f, .37f, ColorSpaces.DisplayP3)
        for (theme in calm) for (color in listOf(theme.haloColor(wide), theme.surface(wide), theme.foreground(wide))) {
            assertEquals(wide.alpha, color.alpha, 0f)
        }
    }

    @Test fun haloUsesLinearIntensityWhileFacesKeepTheirLuminanceAndLabelsStayCalmer() {
        val red = Color.Red
        val quiet = PreviewTheme.Quiet.haloColor(red)
        assertEquals(.45 * (.2126 + .25 * (1.0 - .2126)), linear(quiet.red), .003)
        assertEquals(.45 * .2126 * .75, linear(quiet.green), .003)
        assertEquals(.45 * .2126 * .75, linear(quiet.blue), .003)
        val gray = PreviewTheme.Grayscale.haloColor(red)
        assertEquals(.2 * .2126, linear(gray.red), .003)
        for (theme in calm) {
            for (source in listOf(VoiceInk.ground, VoiceInk.surface, VoiceInk.line, VoiceInk.you, VoiceInk.agent)) {
                val face = theme.surface(source)
                val lower = luminanceWithCodeOffset(face, -.5001f / 255f)
                val upper = luminanceWithCodeOffset(face, .5001f / 255f)
                assertTrue("${theme.key} changed surface luminance beyond 8-bit rounding", luminance(source) in lower..upper)
            }
            assertTrue(luminance(theme.palette.text) < luminance(VoiceInk.text))
            assertTrue(luminance(theme.palette.you) < luminance(VoiceInk.you))
            assertTrue(luminance(theme.palette.you) > luminance(theme.haloColor(VoiceInk.you)))
        }
    }

    @Test fun labelsAndMeaningfulGlyphsMeetTheirFloorsOnActualRockerFaces() {
        for (theme in calm) {
            val palette = theme.palette
            val faces = listOf(palette.ground, palette.surface, palette.line,
                palette.you.copy(alpha = .12f).compositeOver(palette.ground),
                palette.agent.copy(alpha = .12f).compositeOver(palette.ground),
                palette.muted.copy(alpha = .12f).compositeOver(palette.ground),
                palette.you.copy(alpha = .08f).compositeOver(palette.surface),
                palette.you.copy(alpha = .025f).compositeOver(palette.surface))
            for (face in faces) {
                for (ink in listOf(palette.text, palette.muted, palette.you, palette.agent)) {
                    assertTrue("${theme.key} label contrast on ${face.toArgb()}", contrast(ink, face) >= 4.5)
                }
                val glyph = theme.foreground(VoiceInk.muted, background = face, minimumContrast = 3f)
                assertTrue("${theme.key} glyph contrast on ${face.toArgb()}", contrast(glyph, face) >= 3.0)
            }
        }
    }

    @Test fun drawOpacityCountsTowardContrastWithoutRewritingTheCallersAlpha() {
        for (theme in calm) {
            val ground = theme.palette.ground
            val presence = theme.foreground(VoiceInk.muted, ground, opacity = .84f)
            assertEquals(1f, presence.alpha, 0f)
            assertTrue(contrast(presence.copy(alpha = .84f), ground) >= 4.5)
            val custom = Color(0xC0417AB8.toInt())
            val label = theme.foreground(custom, theme.palette.surface, opacity = .84f)
            assertEquals(custom.alpha, label.alpha, 0f)
            assertTrue(contrast(label.copy(alpha = label.alpha * .84f), theme.palette.surface) >= 4.5)
            val faint = Color(0x10417AB8)
            assertEquals(faint.alpha, theme.foreground(faint).alpha, 0f)
        }
    }

    @Test fun resolverIsStrictAndDecorationHasOneSeparateOpacityScale() {
        for ((theme, strength) in listOf(PreviewTheme.Bright to 1f, PreviewTheme.Quiet to .5f, PreviewTheme.Grayscale to .2f)) {
            assertSame(theme, PreviewTheme.resolve(theme.key))
            assertEquals(strength, theme.decorationStrength, 0f)
            val source = Color(0xA0D4FF72.toInt())
            val expected = theme.surface(source).copy(alpha = source.alpha * strength)
            assertEquals(expected, theme.decoration(source))
        }
        for (invalid in listOf("", "Bright", "gray", "quiet ")) {
            assertThrows(IllegalArgumentException::class.java) { PreviewTheme.resolve(invalid) }
        }
    }

    private fun assertBrightIdentity(color: Color) {
        val theme = PreviewTheme.Bright
        assertEquals(color, theme.haloColor(color))
        assertEquals(color, theme.surface(color))
        assertEquals(color, theme.foreground(color, Color.White, 21f, .1f))
        assertEquals(color, theme.decoration(color))
    }

    private fun colors(palette: PreviewPalette) = listOf(palette.ground, palette.surface, palette.text,
        palette.muted, palette.line, palette.you, palette.agent)

    private fun linear(value: Float): Double = if (value <= .04045f) value / 12.92
        else ((value + .055) / 1.055).pow(2.4)

    private fun luminance(color: Color): Double = .2126 * linear(color.red) + .7152 * linear(color.green) + .0722 * linear(color.blue)

    private fun luminanceWithCodeOffset(color: Color, offset: Float): Double =
        .2126 * linear((color.red + offset).coerceIn(0f, 1f)) +
            .7152 * linear((color.green + offset).coerceIn(0f, 1f)) +
            .0722 * linear((color.blue + offset).coerceIn(0f, 1f))

    private fun contrast(ink: Color, face: Color): Double {
        val visible = luminance(ink.compositeOver(face))
        val background = luminance(face)
        return (max(visible, background) + .05) / (min(visible, background) + .05)
    }
}
