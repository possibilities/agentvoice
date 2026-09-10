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
