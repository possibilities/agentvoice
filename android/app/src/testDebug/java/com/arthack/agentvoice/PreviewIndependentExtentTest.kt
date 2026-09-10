package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewIndependentExtentTest {
    @Test fun fourExtentsSurviveVisibilityAndOrientationChanges() {
        val portrait = defaultPortraitLayout().design.copy(controlsHeightDp = 400, controlsWithoutPttDp = 220)
        val landscape = defaultLandscapeLayout().copy(design = defaultLandscapeLayout().design.copy(
            controlsHeightDp = 650, controlsWithoutPttDp = 350))
        val state = PersonaPreviewState(design = portrait, otherLayout = landscape)
        assertEquals(400, state.design.controlsExtent(true))
        assertEquals(220, state.copy(showPushToTalk = false).design.controlsExtent(false))
        val rotated = state.rotate("landscape")
        assertEquals(650, rotated.design.controlsExtent(true))
        assertEquals(350, rotated.design.controlsExtent(false))
        assertEquals(portrait, rotated.rotate("portrait").design)
        assertEquals(portrait.controlsWithoutPttDp, portrait.copy(controlsHeightDp = 900).controlsWithoutPttDp)
    }

    @Test fun widthCanCrossTheMidpointInEitherHandednessWithoutMovingPersona() {
        for (side in listOf("left", "right")) for (padding in listOf(0, 16, 40)) {
            val spacing = PreviewSpacing(paddingDp = padding, sectionGapDp = 80)
            val narrow = previewOrientationGeometry(780f, 360f, 780f, false, 160f, 0f, side, spacing)
            for (extent in listOf(600f, 780f, 1600f)) {
                val wide = previewOrientationGeometry(780f, 360f, 780f, false, extent, 0f, side, spacing)
                assertEquals(minOf(extent, 780f - 2 * padding), wide.deckWidth, 0f)
                assertTrue(wide.deckWidth > 390f)
                assertEquals(narrow.stageX, wide.stageX, 0f)
                assertEquals(narrow.stageY, wide.stageY, 0f)
                assertEquals(narrow.diameter, wide.diameter, 0f)
                assertEquals(360f - 2 * padding, wide.deckViewportHeight, 0f)
                assertEquals(padding.toFloat(), if (side == "left") 780f - wide.deckX - wide.deckWidth else wide.deckX, 0f)
            }
        }
    }
}
