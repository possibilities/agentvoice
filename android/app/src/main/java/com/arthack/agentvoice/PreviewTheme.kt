package com.arthack.agentvoice

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpace
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toArgb
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

@Immutable
internal data class PreviewPalette(
    val ground: Color,
    val surface: Color,
    val text: Color,
    val muted: Color,
    val line: Color,
    val you: Color,
    val agent: Color,
)

internal enum class PreviewTheme(
    val key: String,
    private val chromaRetention: Float,
    private val haloIntensity: Float,
    private val foregroundIntensity: Float,
    val decorationStrength: Float,
) {
    Bright("bright", 1f, 1f, 1f, 1f),
    Quiet("quiet", .25f, .45f, .65f, .5f),
    Grayscale("grayscale", 0f, .2f, .4f, .2f);

    val palette: PreviewPalette by lazy {
        val base = originalPreviewPalette
        if (this == Bright) base else {
            val lowerFace = surface(base.line)
            val primary = if (this == Quiet) Color(0xFFC4C6C0) else Color(0xFFA6A6A6)
            val secondary = if (this == Quiet) Color(0xFF90958E) else Color(0xFF8D8D8D)
            PreviewPalette(surface(base.ground), surface(base.surface),
                contrastFloor(primary, lowerFace, 4.5f, 1f),
                contrastFloor(secondary, lowerFace, 4.5f, 1f), lowerFace,
                foreground(base.you, lowerFace), foreground(base.agent, lowerFace))
        }
    }

    /** Apply once to the raw result of Spirit's color blend, never to its stored base palette. */
    fun haloColor(color: Color): Color = if (this == Bright) color else transform(color, haloIntensity)

    fun haloArgb(argb: Int): Int = if (this == Bright) argb else haloColor(Color(argb)).toArgb()

    fun surface(color: Color): Color = if (this == Bright) color else transform(color, 1f)

    /** Input ink is unthemed; background is the actual themed/composited face. */
    fun foreground(
        color: Color,
        background: Color = surface(originalPreviewPalette.line),
        minimumContrast: Float = 4.5f,
        opacity: Float = 1f,
    ): Color {
        if (this == Bright || color == Color.Unspecified) return color
        return contrastFloor(transform(color, foregroundIntensity), background, minimumContrast, opacity)
    }

    /** This already scales opacity; callers choosing decorationStrength must not apply both. */
    fun decoration(color: Color): Color {
        if (this == Bright || color == Color.Unspecified) return color
        return transform(color, 1f).copy(alpha = color.alpha * decorationStrength)
    }

    private fun transform(color: Color, intensity: Float): Color {
        if (color == Color.Unspecified) return color
        val source = color.linear()
        val luminance = source.luminance
        fun channel(value: Double) = intensity * (luminance + chromaRetention * (value - luminance))
        return LinearRgb(channel(source.red), channel(source.green), channel(source.blue)).color(color.alpha, color.colorSpace)
    }

    private fun contrastFloor(color: Color, background: Color, minimumContrast: Float, opacity: Float): Color {
        val drawOpacity = if (opacity.isFinite()) opacity.coerceIn(0f, 1f) else 1f
        if (color.alpha == 0f || drawOpacity == 0f) return color
        val target = if (minimumContrast.isFinite()) minimumContrast.coerceIn(1f, 21f) else 4.5f
        val ground = surface(originalPreviewPalette.ground)
        val face = if (background == Color.Unspecified) ground else background.compositeOver(ground)
        fun contrast(ink: Color): Double {
            val rendered = ink.copy(alpha = ink.alpha * drawOpacity).compositeOver(face)
            val inkY = rendered.linear().luminance
            val faceY = face.linear().luminance
            return (max(inkY, faceY) + .05) / (min(inkY, faceY) + .05)
        }
        if (contrast(color) >= target) return color
        val white = Color.White.convert(color.colorSpace).copy(alpha = color.alpha)
        val black = Color.Black.convert(color.colorSpace).copy(alpha = color.alpha)
        val endpoint = if (contrast(white) >= contrast(black)) white else black
        // Very low input alpha may make the floor impossible; alpha still belongs to the caller.
        if (contrast(endpoint) < target) return endpoint
        val from = color.linear()
        val to = endpoint.linear()
        var low = 0.0
        var high = 1.0
        var result = endpoint
        repeat(20) {
            val middle = (low + high) / 2.0
            val candidate = from.mix(to, middle).color(color.alpha, color.colorSpace)
            if (contrast(candidate) >= target) { high = middle; result = candidate } else low = middle
        }
        return result
    }

    companion object {
        fun resolve(value: String): PreviewTheme = entries.firstOrNull { it.key == value }
            ?: throw IllegalArgumentException("Unsupported preview theme: $value")
    }
}

internal val LocalPreviewTheme = staticCompositionLocalOf { PreviewTheme.Bright }

private val originalPreviewPalette by lazy {
    PreviewPalette(VoiceInk.ground, VoiceInk.surface, VoiceInk.text, VoiceInk.muted,
        VoiceInk.line, VoiceInk.you, VoiceInk.agent)
}

private data class LinearRgb(val red: Double, val green: Double, val blue: Double) {
    val luminance: Double get() = .2126 * red + .7152 * green + .0722 * blue

    fun mix(other: LinearRgb, fraction: Double) = LinearRgb(
        red + (other.red - red) * fraction,
        green + (other.green - green) * fraction,
        blue + (other.blue - blue) * fraction,
    )

    fun color(alpha: Float, colorSpace: ColorSpace): Color {
        fun encode(value: Double): Float {
            val linear = value.coerceIn(0.0, 1.0)
            return (if (linear <= .0031308) linear * 12.92 else 1.055 * linear.pow(1.0 / 2.4) - .055).toFloat()
        }
        return Color(encode(red), encode(green), encode(blue)).convert(colorSpace).copy(alpha = alpha)
    }
}

private fun Color.linear(): LinearRgb {
    val rgb = convert(ColorSpaces.Srgb)
    fun decode(value: Float): Double {
        val encoded = value.toDouble().coerceIn(0.0, 1.0)
        return if (encoded <= .04045) encoded / 12.92 else ((encoded + .055) / 1.055).pow(2.4)
    }
    return LinearRgb(decode(rgb.red), decode(rgb.green), decode(rgb.blue))
}
