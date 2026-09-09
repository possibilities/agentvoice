package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewOrientationGeometryTest {
    @Test fun portraitSquareAndCenterAreIndependentOfDeckSize() {
        for (height in listOf(400f, 600f, 900f)) for (controls in listOf(240f, 262f, 480f)) {
            val geometry = previewOrientationGeometry(320f, height, 320f, true, controls, 35f)
            assertEquals(320f, geometry.diameter, 0f)
            assertEquals(0f, geometry.stageY, 0f)
            assertEquals(0f, geometry.stageX, 0f)
            assertTrue(geometry.deckY >= 320f)
            assertTrue(geometry.contentHeight >= geometry.deckY + controls + 20f)
            assertEquals(controls, geometry.deckViewportHeight, 0f)
        }
    }

    @Test fun landscapeFitsBothLanesAndOnlyTheDeckScrollsAtLargeSizes() {
        for ((width, height) in listOf(780f to 360f, 900f to 420f, 352f to 320f)) {
            val small = previewOrientationGeometry(width, height, width, false, 240f, 0f)
            val large = previewOrientationGeometry(width, height, width, false, 480f, 0f)
            assertEquals(small.diameter, large.diameter, 0f)
            assertEquals(small.stageX, large.stageX, 0f)
            assertEquals(small.stageY, large.stageY, 0f)
            assertTrue(small.stageX + small.diameter < small.deckX)
            assertTrue(small.deckX + small.deckWidth <= width)
            assertTrue(large.deckViewportHeight < 480f)
            assertTrue(large.deckY + large.deckViewportHeight <= height)
            assertEquals(height, large.contentHeight, 0f)
        }
    }

    @Test fun handednessMirrorsLaneBoundsWithoutChangingTheirDimensions() {
        val left = previewOrientationGeometry(780f, 360f, 780f, false, 262f, -40f)
        val right = previewOrientationGeometry(780f, 360f, 780f, false, 262f, -40f, "right")
        assertEquals(780f - left.stageX - left.diameter, right.stageX, .001f)
        assertEquals(780f - left.deckX - left.deckWidth, right.deckX, .001f)
        assertEquals(left.diameter, right.diameter, 0f)
        assertEquals(left.deckWidth, right.deckWidth, 0f)
        assertEquals(left.deckY, right.deckY, 0f)
        assertEquals(-40f, right.offsetY, 0f)
    }

    @Test fun transitionRetargetsPresentedGeometryAndClampsProgress() {
        val portrait = previewOrientationGeometry(320f, 600f, 320f, true, 262f, 35f)
        val landscape = previewOrientationGeometry(780f, 360f, 780f, false, 262f, 0f)
        val middle = portrait.towards(landscape, .5f)
        assertEquals((portrait.stageX + landscape.stageX) / 2f, middle.stageX, 0f)
        assertEquals(landscape, portrait.towards(landscape, 2f))
        assertEquals(middle.stageX, middle.towards(portrait, 0f).stageX, 0f)
        assertEquals(17.5f, middle.offsetY, 0f)
    }
}
