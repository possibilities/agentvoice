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

    @Test fun provisionalPortraitAndLegacyLandscapeHaveSeparateExplicitDefaults() {
        val portrait = defaultPortraitLayout()
        assertEquals(PersonaPlacement(.78f, .56f, .78f, (-22).dp), portrait.placement)
        assertEquals(387, portrait.design.controlsHeightDp)
        assertEquals(40.9, portrait.design.holdSharePercent, 0.0)
        assertEquals(PreviewTraces("parallel", 130, 175, 88, 0), portrait.design.traces)
        assertEquals(PreviewSpacing(paddingDp = 16), portrait.design.spacing)
        assertEquals("contained", portrait.halo.variant)
        assertEquals(PreviewSpirit("still", 35, "follow"), portrait.spirit)
        val landscape = defaultLandscapeLayout()
        assertEquals(PersonaPlacement(offsetY = 0.dp), landscape.placement)
        assertEquals(262, landscape.design.controlsHeightDp)
        assertEquals(116.0 / 262.0 * 100.0, landscape.design.holdSharePercent, 0.0)
        assertEquals(PreviewTraces(), landscape.design.traces)
        assertEquals(PreviewHalo(), landscape.halo)
        assertEquals(PreviewSpirit(), landscape.spirit)
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
