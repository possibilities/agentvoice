package com.arthack.agentvoice

internal data class PreviewOrientationGeometry(
    val portrait: Boolean,
    val personaSide: String,
    val stageX: Float,
    val stageY: Float,
    val diameter: Float,
    val deckX: Float,
    val deckY: Float,
    val deckWidth: Float,
    val deckViewportHeight: Float,
    val contentHeight: Float,
    val offsetY: Float,
) {
    val layoutKey get() = if (portrait) "portrait" else "landscape-$personaSide"
    fun towards(other: PreviewOrientationGeometry, progress: Float): PreviewOrientationGeometry {
        fun mix(a: Float, b: Float) = a + (b - a) * progress.coerceIn(0f, 1f)
        return other.copy(stageX = mix(stageX, other.stageX), stageY = mix(stageY, other.stageY),
            diameter = mix(diameter, other.diameter), deckX = mix(deckX, other.deckX),
            deckY = mix(deckY, other.deckY), deckWidth = mix(deckWidth, other.deckWidth),
            deckViewportHeight = mix(deckViewportHeight, other.deckViewportHeight),
            contentHeight = mix(contentHeight, other.contentHeight), offsetY = mix(offsetY, other.offsetY))
    }
}

/** Dimensions are dp; tuning values are never rewritten to fit a smaller viewport. */
internal fun previewOrientationGeometry(
    width: Float,
    height: Float,
    screenWidth: Float,
    portrait: Boolean,
    controlsHeight: Float,
    offsetY: Float,
    personaSide: String = "left",
    spacing: PreviewSpacing = PreviewSpacing(),
    actualDeckHeight: Float = controlsHeight,
): PreviewOrientationGeometry {
    require(actualDeckHeight.isFinite() && actualDeckHeight > 0f)
    val baseline = baselinePreviewOrientationGeometry(width, height, screenWidth, portrait, controlsHeight, offsetY, personaSide)
    if (portrait) {
        val desiredSide = if (spacing.paddingDp >= 0) spacing.paddingDp.toFloat()
            else baseline.deckX * spacing.sideMarginPercent / 100f
        // Existing sub-276dp portrait fixtures keep their exact baseline until their sides are edited.
        val side = if (spacing.paddingDp < 0 && spacing.sideMarginPercent == 100) desiredSide else
            minOf(desiredSide, (width - minOf(240f, width)) / 2f)
        val requestedBottom = if (spacing.paddingDp >= 0) side
            else (if (height < 660f) 20f else 28f) * spacing.edgeClearancePercent / 100f
        val bottom = minOf(requestedBottom, (height - 1f).coerceAtLeast(0f))
        val viewport = minOf(actualDeckHeight, height - bottom)
        // The square owns Persona placement, not minimum space above the controls. Section spacing
        // uses only the room left above this bottom-aligned deck; it cannot extend the visible scene.
        val deckTop = (height - bottom - viewport).coerceAtLeast(0f)
        return baseline.copy(deckX = side, deckY = deckTop, deckWidth = (width - side * 2f).coerceAtLeast(1f),
            deckViewportHeight = viewport, contentHeight = height)
    }
    if (spacing == PreviewSpacing() && actualDeckHeight == controlsHeight) return baseline
    val leftPersona = personaSide == "left"
    val baselineInner = if (leftPersona) baseline.deckX else width - baseline.deckX - baseline.deckWidth
    val baselineOuterMargin = width - baselineInner - baseline.deckWidth
    val minimumWidth = minOf(240f, baseline.deckWidth)
    val outerMargin = if (spacing.paddingDp >= 0) spacing.paddingDp.toFloat()
        else baselineOuterMargin * spacing.sideMarginPercent / 100f
    val outer = (width - outerMargin)
        .coerceIn(baselineInner + minimumWidth, width)
    // Constrained controls consume their own spare width; the fixed Persona lane is never borrowed.
    val inner = minOf(baselineInner + spacing.sectionGapDp, outer - minimumWidth)
    val deckWidth = (outer - inner).coerceAtLeast(1f)
    val clearance = if (spacing.paddingDp >= 0) spacing.paddingDp.toFloat()
        else 16f * spacing.edgeClearancePercent / 100f
    val viewport = minOf(actualDeckHeight, (height - clearance * 2f).coerceAtLeast(1f))
    return baseline.copy(deckX = if (leftPersona) inner else width - outer, deckY = (height - viewport) / 2f,
        deckWidth = deckWidth, deckViewportHeight = viewport)
}

private fun baselinePreviewOrientationGeometry(
    width: Float,
    height: Float,
    screenWidth: Float,
    portrait: Boolean,
    controlsHeight: Float,
    offsetY: Float,
    personaSide: String,
): PreviewOrientationGeometry {
    require(listOf(width, height, screenWidth, controlsHeight, offsetY).all { it.isFinite() })
    require(width > 0f && height > 0f && screenWidth > 0f && controlsHeight > 0f)
    require(personaSide in setOf("left", "right"))
    val side = if (width < 360f) 18f else 24f
    if (portrait) {
        val bottom = minOf(if (height < 660f) 20f else 28f, (height - 1f).coerceAtLeast(0f))
        val viewport = minOf(controlsHeight, height - bottom)
        val deckTop = (height - viewport - bottom).coerceAtLeast(0f)
        return PreviewOrientationGeometry(true, personaSide, (width - screenWidth) / 2f, 0f, screenWidth,
            side, deckTop, (width - side * 2f).coerceAtLeast(1f), viewport, height, offsetY)
    }
    val innerWidth = (width - side * 2f).coerceAtLeast(2f)
    val gap = minOf(24f, innerWidth * .08f)
    val usable = innerWidth - gap
    val deckWidth = (usable / 2f).coerceIn(minOf(300f, usable * .58f), minOf(420f, usable * .7f))
    val personaLane = usable - deckWidth
    val diameter = minOf(height, personaLane).coerceAtLeast(1f)
    val deckViewport = minOf(controlsHeight, (height - 32f).coerceAtLeast(1f))
    val stageLeft = side + (personaLane - diameter) / 2f
    val deckLeft = side + personaLane + gap
    return PreviewOrientationGeometry(false, personaSide,
        if (personaSide == "left") stageLeft else width - stageLeft - diameter,
        (height - diameter) / 2f, diameter,
        if (personaSide == "left") deckLeft else width - deckLeft - deckWidth,
        (height - deckViewport) / 2f, deckWidth, deckViewport, height, offsetY)
}
