package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewHorizontalPositionTest {
    @Test fun portraitIgnoresLandscapePositionAndKeepsItsVerticalPlacement() {
        val baseline = previewOrientationGeometry(390f, 780f, 390f, true, 387f, -83f)
        for (offset in listOf(-200f, 0f, 200f)) {
            assertEquals(baseline, previewOrientationGeometry(390f, 780f, 390f, true, 387f, -83f,
                horizontalOffsetDp = offset))
        }
    }

    @Test fun eitherPersonaSideMovesInTheSameScreenDirectionWithoutMovingDeckOrChangingSize() {
        for (side in listOf("left", "right")) {
            for (spacing in listOf(PreviewSpacing(), PreviewSpacing(sectionGapDp = 80, paddingDp = 40))) {
                for (height in listOf(262f, 480f)) {
                    val baseline = landscape(side, spacing, height)
                    for (offset in listOf(-200f, -37f, 58f, 200f)) {
                        val moved = landscape(side, spacing, height, offset)
                        assertEquals(baseline.stageX + offset, moved.stageX, .001f)
                        assertEquals(offset, moved.horizontalOffsetDp, 0f)
                        assertEquals(baseline, moved.copy(stageX = baseline.stageX, horizontalOffsetDp = 0f))
                    }
                }
            }
        }
    }

    @Test fun movingTheNominalSquareAcrossTheDeckDoesNotEraseTheRoutingGutter() {
        for (side in listOf("left", "right")) {
            val baseline = landscape(side)
            val gutter = previewLandscapeTraceGutterDp(baseline)
            assertTrue(gutter > 0f)
            for (offset in listOf(-200f, -37f, 58f, 200f)) {
                assertEquals(gutter, previewLandscapeTraceGutterDp(landscape(side, offset = offset)), .001f)
            }
            val overlapping = landscape(side, offset = if (side == "left") 200f else -200f)
            if (side == "left") assertTrue(overlapping.stageX + overlapping.diameter > overlapping.deckX)
            else assertTrue(overlapping.stageX < overlapping.deckX + overlapping.deckWidth)
        }
    }

    @Test fun positionTransitionsRetainTheFixedTraceLane() {
        for (side in listOf("left", "right")) {
            val start = landscape(side, offset = -200f)
            val end = landscape(side, offset = 200f)
            for (progress in listOf(0f, .25f, .5f, .75f, 1f)) {
                val presented = start.towards(end, progress)
                assertEquals(-200f + 400f * progress, presented.horizontalOffsetDp, .001f)
                assertEquals(previewLandscapeTraceGutterDp(start), previewLandscapeTraceGutterDp(presented), .001f)
            }
        }
    }

    @Test fun rotatingToPortraitInterpolatesTheRenderedShiftBackToZero() {
        val landscape = landscape("right", offset = 80f)
        val portrait = previewOrientationGeometry(390f, 780f, 390f, true, 387f, -22f,
            horizontalOffsetDp = 80f)
        assertEquals(40f, landscape.towards(portrait, .5f).horizontalOffsetDp, 0f)
        assertEquals(portrait, landscape.towards(portrait, 1f))
    }

    @Test(expected = IllegalArgumentException::class)
    fun nonFinitePositionCannotEnterTheRenderedGeometry() {
        landscape("left", offset = Float.NaN)
    }

    private fun landscape(side: String, spacing: PreviewSpacing = PreviewSpacing(),
        height: Float = 262f, offset: Float = 0f): PreviewOrientationGeometry =
        previewOrientationGeometry(780f, 360f, 780f, false, height, 0f, side,
            spacing, height, horizontalOffsetDp = offset)
}
