package com.arthack.agentvoice

/** Bounds hard ellipse strokes across the pinned Contained tracks; diffuse glow can enter this space. */
internal fun previewMutedApertureFactor(halo: PreviewHalo): Float {
    if (halo.variant != "contained") return .16f
    val spread = 1f - .6f * halo.ringSpreadPercent / 100f
    val pulse = 1f - (10f / 128f) * halo.listeningPulsePercent / 100f
    val idle = 1f - .06f * halo.idleBreathingPercent / 100f
    val speaking = 1f - .071875f * halo.speakingMotionPercent / 100f
    // Radius64 in the256-unit artboard is .25; .20 leaves room inside the authored strokes.
    return .20f * spread * pulse * idle * speaking
}
