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
): PreviewOrientationGeometry {
    require(listOf(width, height, screenWidth, controlsHeight, offsetY).all { it.isFinite() })
    require(width > 0f && height > 0f && screenWidth > 0f && controlsHeight > 0f)
    require(personaSide in setOf("left", "right"))
    val side = if (width < 360f) 18f else 24f
    if (portrait) {
        val bottom = if (height < 660f) 20f else 28f
        val minimumStage = if (height < 500f) 230f else 160f
        val deckTop = maxOf(screenWidth, (height - controlsHeight - bottom).coerceAtLeast(minimumStage))
        return PreviewOrientationGeometry(true, personaSide, (width - screenWidth) / 2f, 0f, screenWidth,
            side, deckTop, (width - side * 2f).coerceAtLeast(1f), controlsHeight,
            maxOf(height, deckTop + controlsHeight + bottom), offsetY)
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
