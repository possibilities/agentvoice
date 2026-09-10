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

    @Test fun movingTheNominalSquareKeepsSideContactsFixedUntilTheActualApertureOverlaps() {
        for (side in listOf("left", "right")) {
            val baseline = previewLandscapeTraceGeometry(landscape(side), 780f, 1f, 30f)!!
            assertTrue(baseline.routes.isNotEmpty())
            for (offset in listOf(-60f, 0f, 60f)) {
                val moved = previewLandscapeTraceGeometry(landscape(side, offset = offset), 780f, 1f, 30f)!!
                assertEquals(baseline.routes.map { it.landing }, moved.routes.map { it.landing })
                assertEquals(baseline.center.x + offset, moved.center.x, .001f)
            }
            val frame = landscape(side)
            val edge = frame.deckX + if (side == "right") frame.deckWidth else 0f
            val overlap = landscape(side, offset = edge - frame.stageX - frame.diameter / 2f)
            assertTrue(previewLandscapeTraceGeometry(overlap, 780f, 1f, 30f)!!.routes.isEmpty())
        }
    }

    @Test fun positionTransitionsRetainTheFixedSideContacts() {
        for (side in listOf("left", "right")) {
            val start = landscape(side, offset = -60f)
            val end = landscape(side, offset = 60f)
            val feet = previewLandscapeTraceGeometry(start, 780f, 1f, 30f)!!.routes.map { it.landing }
            for (progress in listOf(0f, .25f, .5f, .75f, 1f)) {
                val presented = start.towards(end, progress)
                assertEquals(-60f + 120f * progress, presented.horizontalOffsetDp, .001f)
                assertEquals(feet, previewLandscapeTraceGeometry(presented, 780f, 1f, 30f)!!.routes.map { it.landing })
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
