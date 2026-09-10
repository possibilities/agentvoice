package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Test

class PreviewSpacingTest {
    @Test fun spacingDefaultsPreserveTheExistingDeckAndBoundsAreExplicit() {
        assertEquals(PreviewSpacing(100, 100, 0, 10, 16), PreviewSpacing())
        PreviewSpacing(0, 0, 0, 0, 0)
        PreviewSpacing(200, 200, 80, 40, 48)
        for (invalid in listOf<() -> PreviewSpacing>(
            { PreviewSpacing(sideMarginPercent = -1) }, { PreviewSpacing(sideMarginPercent = 201) },
            { PreviewSpacing(edgeClearancePercent = -1) }, { PreviewSpacing(edgeClearancePercent = 201) },
            { PreviewSpacing(sectionGapDp = -1) }, { PreviewSpacing(sectionGapDp = 81) },
            { PreviewSpacing(channelGapDp = -1) }, { PreviewSpacing(channelGapDp = 41) },
            { PreviewSpacing(pushGapDp = -1) }, { PreviewSpacing(pushGapDp = 49) },
            { PreviewSpacing(paddingDp = -2) }, { PreviewSpacing(paddingDp = 41) },
        )) assertThrows(IllegalArgumentException::class.java) { invalid() }
    }

    @Test fun orientationsKeepSeparateGeometryAndShareAppearanceByDefault() {
        val portrait = defaultPortraitLayout()
        assertEquals(ShippingDesign.portrait.previewLayout(), portrait)
        val landscape = defaultLandscapeLayout()
        assertEquals(ShippingDesign.landscape.previewLayout(), landscape)
        assertNotEquals(portrait.placement, landscape.placement)
        assertNotEquals(portrait.design.controlsHeightDp, landscape.design.controlsHeightDp)
        assertEquals(portrait.design.spacing, landscape.design.spacing)
        assertEquals(portrait.design.traces, landscape.design.traces)
        assertEquals(portrait.halo.copy(containedSizePercent = landscape.halo.containedSizePercent), landscape.halo)
        assertEquals(portrait.spirit, landscape.spirit)
        // These constructors also own old profile omissions and production placement defaults.
        assertEquals(35.dp, PersonaPlacement().offsetY)
        assertEquals(.58f, PersonaPlacement().listeningScale, 0f)
        assertEquals(262, PreviewDesign().controlsHeightDp)
        assertEquals("fixed", PreviewSpirit().persona)
    }

    @Test fun sessionPresentationSurvivesRotationWithoutEnteringEitherLayout() {
        val initial = PersonaPreviewState(theme = "grayscale", mutedPresence = "off").beginHold()
        val landscape = initial.rotate("landscape")
        assertFalse(landscape.holding)
        assertEquals("grayscale", landscape.theme)
        assertEquals("off", landscape.mutedPresence)
        assertEquals(defaultLandscapeLayout(), landscape.activeLayout())
        val portrait = landscape.rotate("portrait")
        assertEquals(defaultPortraitLayout(), portrait.activeLayout())
        assertEquals("grayscale", portrait.theme)
        assertEquals("off", portrait.mutedPresence)
        assertEquals(initial.activeLayout(), portrait.activeLayout())
        assertThrows(IllegalArgumentException::class.java) { initial.copy(theme = "neon") }
        assertThrows(IllegalArgumentException::class.java) { initial.copy(mutedPresence = "always") }
    }
}
