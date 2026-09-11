package com.arthack.agentvoice

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewDisplayedTraceTest {
    @get:Rule val compose = createComposeRule()

    @Test fun portraitRedrawsFromDisplayedScaleWithoutRecomposition() = verify(false)
    @Test fun landscapeRedrawsFromDisplayedScaleWithoutRecomposition() = verify(true)

    private fun verify(landscape: Boolean) {
        val placement = PersonaDisplayedPlacement()
        val applied = mutableFloatStateOf(1f)
        var compositions = 0
        compose.setContent {
            SideEffect { compositions++ }
            val provider = { placement.scale?.let { (it * 80f).dp } ?: 220.dp }
            val modifier = Modifier.size(320.dp).testTag("traces")
            if (landscape) {
                val geometry = PreviewOrientationGeometry(false, "left", 0f, 60f, 200f,
                    250f, 20f, 60f, 280f, 320f, 0f)
                PreviewLandscapeTraces(geometry, 220.dp, PreviewDesign(), modifier, provider)
            } else PreviewPersonaTraces(250.dp, 60.dp, 16.dp, modifier,
                130.dp, 220.dp, displayedClearRadius = provider)
        }
        fun pixels(): IntArray {
            val map = compose.onNodeWithTag("traces").captureToImage().toPixelMap()
            return IntArray(map.width * map.height) { map[it % map.width, it / map.width].toArgb() }
        }
        val fallback = pixels()
        val initialCompositions = compositions
        compose.runOnIdle { placement.bind(applied) }
        val bound = pixels()
        assertFalse("The displayed smaller Persona must restore collapsed routes", fallback.contentEquals(bound))
        compose.runOnIdle { applied.floatValue = .5f }
        assertFalse("Scale changes must invalidate the draw phase", bound.contentEquals(pixels()))
        compose.runOnIdle { placement.release(applied) }
        assertArrayEquals("An unbound view must restore the conservative fallback", fallback, pixels())
        assertEquals("Reading applied scale must not recompose the scene", initialCompositions, compositions)
    }
}
