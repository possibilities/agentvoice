package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewOrientationGeometryTest {
    @Test fun portraitSquareAndCenterStayFixedWhileTheDeckUsesOnlyVisibleHeight() {
        for (height in listOf(400f, 600f, 900f)) for (controls in listOf(240f, 262f, 480f)) {
            val geometry = previewOrientationGeometry(320f, height, 320f, true, controls, 35f)
            assertEquals(320f, geometry.diameter, 0f)
            assertEquals(0f, geometry.stageY, 0f)
            assertEquals(0f, geometry.stageX, 0f)
            val bottom = if (height < 660f) 20f else 28f
            assertEquals(height, geometry.contentHeight, 0f)
            assertEquals(minOf(controls, height - bottom), geometry.deckViewportHeight, 0f)
            assertEquals(bottom, height - geometry.deckY - geometry.deckViewportHeight, .001f)
            assertTrue(geometry.deckY >= 0f)
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

    @Test fun everySpacingExtremeKeepsManualPersonaBoundsAndOffset() {
        for ((width, height) in listOf(320f to 600f, 250f to 400f, 180f to 220f, 780f to 360f, 352f to 320f)) {
            val portrait = height >= width
            for (side in listOf("left", "right")) for (offset in listOf(-200f, -22f, 200f)) {
                val baseline = previewOrientationGeometry(width, height, width, portrait, 387f, offset, side)
                for (margin in listOf(0, 100, 200)) for (edge in listOf(0, 100, 200))
                    for (gap in listOf(0, 80)) for (push in listOf(0, 16, 48)) {
                        val spacing = PreviewSpacing(margin, edge, gap, 40, push)
                        val geometry = previewOrientationGeometry(width, height, width, portrait, 387f, offset, side,
                            spacing, 387f + push - 16f)
                        assertEquals(baseline.stageX, geometry.stageX, 0f)
                        assertEquals(baseline.stageY, geometry.stageY, 0f)
                        assertEquals(baseline.diameter, geometry.diameter, 0f)
                        assertEquals(baseline.offsetY, geometry.offsetY, 0f)
                        assertTrue(geometry.deckWidth > 0f && geometry.deckViewportHeight > 0f)
                        assertTrue(geometry.deckX >= 0f && geometry.deckX + geometry.deckWidth <= width + .001f)
                        if (portrait) {
                            assertEquals(height, geometry.contentHeight, 0f)
                            assertTrue(geometry.deckY >= 0f)
                            assertTrue(geometry.deckY + geometry.deckViewportHeight <= height + .001f)
                            assertTrue(geometry.deckViewportHeight <= 387f + push - 16f)
                        } else {
                            assertTrue(geometry.deckWidth >= minOf(240f, baseline.deckWidth) - .001f)
                            if (side == "left") assertTrue(geometry.deckX > geometry.stageX + geometry.diameter)
                            else assertTrue(geometry.deckX + geometry.deckWidth < geometry.stageX)
                            assertTrue(geometry.deckY + geometry.deckViewportHeight <= height + .001f)
                        }
                    }
            }
        }
    }

    @Test fun onlyEditedPortraitSidesAreBoundedByTheUsableWidth() {
        val legacy = previewOrientationGeometry(250f, 400f, 250f, true, 262f, 35f)
        assertEquals(18f, legacy.deckX, 0f)
        assertEquals(214f, legacy.deckWidth, 0f)
        val spaced = previewOrientationGeometry(250f, 400f, 250f, true, 262f, 35f,
            spacing = PreviewSpacing(sideMarginPercent = 200))
        assertEquals(240f, spaced.deckWidth, 0f)
        val narrow = previewOrientationGeometry(180f, 220f, 180f, true, 262f, 35f,
            spacing = PreviewSpacing(sideMarginPercent = 200))
        assertEquals(180f, narrow.deckWidth, 0f)
        assertEquals(0f, narrow.deckY, 0f)
        assertEquals(200f, narrow.deckViewportHeight, 0f)
        assertEquals(220f, narrow.contentHeight, 0f)
    }
    @Test fun linkedPaddingMatchesSidesBottomAndEveryButtonGapWithoutMovingPersona() {
        for (padding in listOf(0, 8, 16, 24, 40)) for (height in listOf(650f, 1000f)) {
            val spacing = PreviewSpacing(paddingDp = padding)
            val deck = PreviewControlGeometry(387, 40.9, spacing.effectivePushGapDp)
            val g = previewOrientationGeometry(360f, height, 360f, true, 387f, -22f,
                spacing = spacing, actualDeckHeight = deck.extentHeightDp)
            assertEquals(padding.toFloat(), g.deckX, 0f)
            assertEquals(padding.toFloat(), g.contentHeight - g.deckY - deck.extentHeightDp, .001f)
            assertEquals(padding, spacing.effectiveChannelGapDp)
            assertEquals(padding, spacing.effectivePushGapDp)
            assertEquals(360f, g.diameter, 0f)
            assertEquals(0f, g.stageY, 0f)
            assertEquals(-22f, g.offsetY, 0f)
            assertEquals(height, g.contentHeight, 0f)
        }
    }

    @Test fun portraitUsesEmptySquareSpaceBeforeClippingOrShrinkingTheDeck() {
        val spacing = PreviewSpacing(sectionGapDp = 80, paddingDp = 24)
        val geometry = previewOrientationGeometry(390f, 780f, 390f, true, 387f, -22f,
            spacing = spacing, actualDeckHeight = 395f)
        assertEquals(395f, geometry.deckViewportHeight, 0f)
        assertEquals(361f, geometry.deckY, 0f)
        assertTrue(geometry.deckY < geometry.stageY + geometry.diameter)
        assertEquals(24f, 780f - geometry.deckY - geometry.deckViewportHeight, 0f)
        assertEquals(780f, geometry.contentHeight, 0f)
        val withoutGap = previewOrientationGeometry(390f, 780f, 390f, true, 387f, -22f,
            spacing = spacing.copy(sectionGapDp = 0), actualDeckHeight = 395f)
        assertEquals(withoutGap, geometry)
    }

    @Test fun impossiblePortraitDeckReceivesAnExplicitVisibleBudgetWithoutMovingPersona() {
        for (height in listOf(.5f, 20f, 180f, 320f)) {
            val geometry = previewOrientationGeometry(320f, height, 320f, true, 480f, -83f,
                spacing = PreviewSpacing(paddingDp = 40), actualDeckHeight = 504f)
            assertEquals(height, geometry.contentHeight, 0f)
            assertEquals(0f, geometry.deckY, .001f)
            assertTrue(geometry.deckViewportHeight > 0f && geometry.deckViewportHeight <= height)
            assertEquals(320f, geometry.diameter, 0f)
            assertEquals(0f, geometry.stageY, 0f)
            assertEquals(-83f, geometry.offsetY, 0f)
        }
    }

}
