package com.arthack.agentvoice

import kotlin.math.abs

internal data class PreviewLandscapeTraceGeometry(
    val center: PreviewTracePoint,
    val deckEdgeX: Float,
    val strokeWidth: Float,
    val contactWidth: Float,
    val routes: List<PreviewTraceRoute>,
)

/** The shared engine's across-deck axis becomes top-to-bottom, preserving HUMAN above AGENT. */
internal fun previewLandscapeTraceGeometry(
    geometry: PreviewOrientationGeometry,
    viewportWidth: Float,
    unit: Float,
    personaClearRadius: Float,
    settings: PreviewTraces = PreviewTraces(),
    channelGapDp: Int = 10,
): PreviewLandscapeTraceGeometry? {
    if (!viewportWidth.isFinite() || !unit.isFinite() || viewportWidth <= 0f || unit <= 0f) return null
    val center = PreviewTracePoint((geometry.stageX + geometry.diameter / 2f) * unit,
        (geometry.stageY + geometry.diameter / 2f + geometry.offsetY) * unit)
    val deckCenterY = (geometry.deckY + geometry.deckViewportHeight / 2f) * unit
    // Stable landscape centers align. Relocation must never attach ink to an invented aperture.
    if (!center.y.isFinite() || abs(center.y - deckCenterY) > .01f * unit) return null
    val mirror = geometry.personaSide == "right"
    fun forward(x: Float) = if (mirror) viewportWidth - x else x
    val deckEdge = (geometry.deckX + if (mirror) geometry.deckWidth else 0f) * unit
    val portrait = previewTraceGeometry(geometry.deckViewportHeight * unit, viewportWidth, forward(deckEdge),
        geometry.deckWidth * unit, 0f, forward(center.x), personaClearRadius, unit, settings, channelGapDp) ?: return null
    fun point(point: PreviewTracePoint) = PreviewTracePoint(forward(point.y), geometry.deckY * unit + point.x)
    return PreviewLandscapeTraceGeometry(center, deckEdge, portrait.strokeWidth, portrait.contactWidth,
        portrait.routes.map { PreviewTraceRoute(point(it.port), point(it.contactEnd), point(it.landing), it.points.map(::point)) })
}
