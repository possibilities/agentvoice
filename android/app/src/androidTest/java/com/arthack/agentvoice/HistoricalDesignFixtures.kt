package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import java.io.File

/** Fixed pre-promotion values used to manufacture historical profiles; never a moving shipping default. */
internal fun historicalPortraitLayout() = PreviewLayout(
    placement = PersonaPlacement(.78f, .56f, .78f, (-22).dp),
    design = PreviewDesign(controlsHeightDp = 387, holdSharePercent = 40.9,
        traces = PreviewTraces("parallel", 130, 175, 0), spacing = PreviewSpacing(paddingDp = 16)),
    halo = PreviewHalo(variant = "contained"), spirit = PreviewSpirit(persona = "follow"),
)
internal fun historicalLandscapeLayout() = PreviewSharedAppearance.from(historicalPortraitLayout()).applyTo(
    PreviewLayout(design = PreviewDesign(spacing = PreviewSpacing(paddingDp = 16))))
internal fun historicalPreviewSession(file: File): PersonaPreviewSession {
    val p = historicalPortraitLayout()
    return PersonaPreviewSession(p.placement, file, p.design, p.halo, p.spirit, historicalLandscapeLayout())
}

/** Protocols through 26 had two physical layouts; restoration clones each axis in memory. */
internal fun PersonaPreviewState.withLegacyAxisClones(): PersonaPreviewState {
    val current = mapOf(
        previewPortrait to activeLayout(),
        previewLandscape to otherLayout,
        previewPortraitReverse to activeLayout(),
        previewLandscapeReverse to otherLayout,
    )
    val savedValues = mapOf(
        previewPortrait to savedLayout(),
        previewLandscape to savedOtherLayout,
        previewPortraitReverse to savedLayout(),
        previewLandscapeReverse to savedOtherLayout,
    )
    return withLayoutMaps(current, savedValues)
}
