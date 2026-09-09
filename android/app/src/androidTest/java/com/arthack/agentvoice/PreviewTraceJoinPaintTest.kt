package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewTraceJoinPaintTest {
    @get:Rule val compose = createComposeRule()

    @Test fun defaultBrushMatchesTheExistingSoftUnderlapPixels() {
        compose.setContent {
            Canvas(Modifier.size(320.dp, 160.dp).testTag("trace-ink")) {
                val color = Color.White.copy(alpha = .84f)
                val center = Offset(80.5f, 80.5f)
                drawRect(Color.Red)
                val old = Brush.radialGradient(0f to color.copy(alpha = 0f), 40f / 52f to color.copy(alpha = 0f),
                    42f / 52f to color.copy(alpha = color.alpha * .72f), 1f to color, center = center, radius = 52f)
                drawRect(old, size = Size(160f, 160f))
                drawRect(previewTraceInk(color, center + Offset(160f, 0f), previewTraceJoin(40f, 1f, PreviewTraces())!!),
                    topLeft = Offset(160f, 0f), size = Size(160f, 160f))
            }
        }
        val pixels = compose.onNodeWithTag("trace-ink").captureToImage().toPixelMap()
        for (y in 0 until 160) for (x in 0 until 160) {
            assertEquals("Default trace opacity changed at $x,$y", pixels[x, y].toArgb(), pixels[x + 160, y].toArgb())
        }
    }

    @Test fun hardTipAndZeroFadePreserveUnderlyingPixelsInsideTheDisk() {
        var settings by mutableStateOf(PreviewTraces(reachDp = 20, fadeLengthDp = 24, tipOpacityPercent = 25))
        compose.setContent {
            Canvas(Modifier.size(160.dp).testTag("trace-ink")) {
                drawRect(Color.Red)
                drawRect(previewTraceInk(Color.White, Offset(80.5f, 80.5f), previewTraceJoin(60f, 1f, settings)!!))
            }
        }
        fun green(distance: Int): Float {
            val pixel = compose.onNodeWithTag("trace-ink").captureToImage().toPixelMap()[80 + distance, 80]
            assertEquals("Trace transparency must preserve the underlying red layer", 1f, pixel.red, .01f)
            return pixel.green
        }
        assertEquals(0f, green(39), .01f)
        // Duplicate radial stops may select the inner color exactly on the hard boundary.
        assertEquals(.385f, green(41), .03f)
        assertEquals(.79f, green(44), .03f)
        assertEquals(1f, green(64), .01f)
        compose.runOnIdle { settings = settings.copy(tipOpacityPercent = 100) }
        assertEquals(0f, green(39), .01f)
        assertEquals(1f, green(41), .01f)
        compose.runOnIdle { settings = settings.copy(fadeLengthDp = 0, tipOpacityPercent = 0) }
        assertEquals(0f, green(39), .01f)
        assertEquals(1f, green(41), .01f)
        compose.runOnIdle { settings = settings.copy(reachDp = 120) }
        assertEquals(1f, green(0), .01f)
    }
}
