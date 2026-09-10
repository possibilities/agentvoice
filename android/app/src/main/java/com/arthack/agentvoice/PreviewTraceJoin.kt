package com.arthack.agentvoice

/** Radial opacity belongs to trace ink alone; a zero join radius deliberately protects no disk. */
internal data class PreviewTraceJoin(
    val radiusPx: Float,
    val fadeLengthPx: Float,
    val tipOpacity: Float,
) {
    init {
        require(radiusPx.isFinite() && radiusPx >= 0f && fadeLengthPx.isFinite() && fadeLengthPx >= 0f)
        require(tipOpacity.isFinite() && tipOpacity in 0f..1f && (radiusPx + fadeLengthPx).isFinite())
    }

    val outerRadiusPx get() = radiusPx + fadeLengthPx
    private val shoulderOpacity get() = tipOpacity + (1f - tipOpacity) * .72f
    private val hardEdge get() = fadeLengthPx == 0f || outerRadiusPx == radiusPx

    fun alphaAt(distancePx: Float): Float {
        if (!distancePx.isFinite() || distancePx < radiusPx) return 0f
        // A zero-length fade has no tip span: ink is full immediately outside the hard edge.
        if (hardEdge) return 1f
        val progress = ((distancePx - radiusPx) / fadeLengthPx).coerceIn(0f, 1f)
        return if (progress <= 1f / 6f) tipOpacity + (shoulderOpacity - tipOpacity) * progress * 6f
            else shoulderOpacity + (1f - shoulderOpacity) * (progress * 6f - 1f) / 5f
    }

    /** Duplicate stops create the hard transparent-to-tip boundary without a source-pixel mask. */
    fun opacityStops(): List<Pair<Float, Float>> {
        if (hardEdge) return if (radiusPx == 0f) listOf(0f to 1f, 1f to 1f)
            else listOf(0f to 0f, 1f to 0f, 1f to 1f)
        val join = radiusPx / outerRadiusPx
        return buildList {
            if (radiusPx > 0f) {
                add(0f to 0f)
                add(join to 0f)
                if (tipOpacity > 0f) add(join to tipOpacity)
            } else add(0f to tipOpacity)
            add((radiusPx + fadeLengthPx / 6f) / outerRadiusPx to shoulderOpacity)
            add(1f to 1f)
        }
    }
}

internal fun previewTraceJoin(clearRadiusPx: Float, unitPx: Float, settings: PreviewTraces): PreviewTraceJoin? {
    if (!clearRadiusPx.isFinite() || clearRadiusPx < 0f || !unitPx.isFinite() || unitPx <= 0f) return null
    val radius = (clearRadiusPx - settings.reachDp * unitPx).coerceAtLeast(0f)
    val fade = settings.fadeLengthDp * unitPx
    if (!radius.isFinite() || !fade.isFinite() || !(radius + fade).isFinite()) return null
    return PreviewTraceJoin(radius, fade, settings.tipOpacityPercent / 100f)
}
