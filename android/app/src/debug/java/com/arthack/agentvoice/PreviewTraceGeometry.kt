package com.arthack.agentvoice

import kotlin.math.sqrt

internal data class PreviewTracePoint(val x: Float, val y: Float)

internal data class PreviewTraceRoute(
    val port: PreviewTracePoint,
    val contactEnd: PreviewTracePoint,
    val landing: PreviewTracePoint,
    val points: List<PreviewTracePoint>,
)

internal data class PreviewTraceGeometry(
    val deckTop: Float,
    val endY: Float,
    val strokeWidth: Float,
    val contactWidth: Float,
    val routes: List<PreviewTraceRoute>,
    val offshoots: List<List<PreviewTracePoint>>,
)

/** All coordinates are pixels. Only allocated placement and operator settings determine a route. */
internal fun previewTraceGeometry(
    width: Float,
    height: Float,
    stageHeight: Float,
    controlsHeight: Float,
    sideInset: Float,
    personaCenterY: Float,
    personaClearRadius: Float,
    unit: Float,
    settings: PreviewTraces = PreviewTraces(),
): PreviewTraceGeometry? {
    if (listOf(width, height, stageHeight, controlsHeight, sideInset, personaCenterY,
            personaClearRadius, unit).any { !it.isFinite() }) return null
    if (width <= 0f || height <= 0f || stageHeight <= 0f || controlsHeight <= 0f ||
        personaClearRadius < 0f || unit <= 0f) return null
    if (settings.pattern !in setOf("parallel", "splayed", "circuit")) return null
    val end = minOf(stageHeight + 4f * unit, stageHeight + controlsHeight, height)
    val inset = sideInset.coerceAtLeast(0f)
    val gap = 10f * unit
    val channelWidth = (width - inset * 2f - gap) / 2f
    val stroke = 1.2f * unit * settings.weightPercent.coerceIn(50, 250) / 100f
    if (!end.isFinite() || !channelWidth.isFinite() || !stroke.isFinite() ||
        end <= stageHeight || channelWidth <= maxOf(12f * unit, stroke * 5f)) return null

    val originalFractions = if (settings.pattern == "splayed") listOf(.16f, .29f, .42f) else listOf(.22f, .36f)
    val fractions = if (settings.personaSpacingPercent == 100) originalFractions else originalFractions.map {
        .29f + (it - .29f) * settings.personaSpacingPercent / 100f
    }
    val baselineLane = minOf(8f * unit, channelWidth / (fractions.size + 2f))
    val lane = if (settings.footSpacingPercent == 100) baselineLane else baselineLane * settings.footSpacingPercent / 100f
    val halfSpan = (fractions.size - 1) * lane / 2f
    val margin = minOf(8f * unit, channelWidth * .16f)
    val nearest = gap / 2f + margin + halfSpan
    val farthest = gap / 2f + channelWidth - margin - halfSpan
    if (nearest > farthest) return null
    val reach = gap / 2f + channelWidth / 2f
    val stance = (reach * settings.stancePercent.coerceIn(75, 150) / 100f).coerceIn(nearest, farthest)
    val radius = personaClearRadius
    val ports = fractions.mapIndexedNotNull { index, fraction ->
        val landing = stance + (index - (fractions.size - 1) / 2f) * lane
        // Outward-only travel cannot fold a line back across the clear center at a wide aperture.
        val x = minOf(radius * fraction, (landing - 4f * unit).coerceAtLeast(0f))
        val y = personaCenterY + circleHeight(radius, x)
        val available = end - y
        if (!y.isFinite() || available <= maxOf(.25f * unit, stroke / 4f)) null
        else TracePort(index, x, y, y + minOf(8f * unit, available * .22f), landing)
    }
    val routes = mutableListOf<PreviewTraceRoute>()
    if (ports.isNotEmpty()) {
        val sharedStart = ports.maxOf { it.contactEndY }
        repeat(2) { side ->
            val sign = if (side == 0) -1f else 1f
            fun point(x: Float, y: Float) = PreviewTracePoint(width / 2f + sign * x, y)
            for (port in ports) {
                val points = traceRoute(port, sharedStart, end, unit, settings.pattern)
                    .map { point(it.x, it.y) }
                    .withoutRepeatedPoints()
                routes += PreviewTraceRoute(point(port.x, port.y), point(port.x, port.contactEndY),
                    point(port.landing, end), points)
            }
        }
    }
    val offshoots = traceOffshoots(width, stageHeight, inset, personaCenterY, radius, unit)
    if ((routes.flatMap { it.points } + offshoots.flatten()).any { !it.x.isFinite() || !it.y.isFinite() }) return null
    return PreviewTraceGeometry(stageHeight, end, stroke, minOf(maxOf(4f * unit, stroke * 1.5f), lane * .7f),
        routes, offshoots)
}

private data class TracePort(val index: Int, val x: Float, val y: Float, val contactEndY: Float, val landing: Float)

private fun circleHeight(radius: Float, x: Float): Float {
    if (radius <= 0f) return 0f
    val fraction = x.toDouble() / radius.toDouble()
    return (radius.toDouble() * sqrt((1.0 - fraction * fraction).coerceAtLeast(0.0))).toFloat()
}

private fun traceRoute(port: TracePort, sharedStart: Float, end: Float, unit: Float, pattern: String): List<PreviewTracePoint> {
    val points = mutableListOf(PreviewTracePoint(port.x, port.y), PreviewTracePoint(port.x, port.contactEndY))
    fun add(x: Float, y: Float) { points += PreviewTracePoint(x, y) }
    val rise = end - sharedStart
    val travel = port.landing - port.x
    when (pattern) {
        "splayed" -> {
            add(port.x, sharedStart + rise * .18f)
            add(port.landing, sharedStart + rise * .76f)
        }
        "circuit" -> {
            val first = sharedStart + rise * (.25f - port.index * .07f)
            val second = sharedStart + rise * (.68f - port.index * .07f)
            val middle = port.x + travel * .48f
            val corner = minOf(6f * unit, travel * .1f, rise * .05f)
            add(port.x, first - corner)
            add(port.x + corner, first)
            add(middle - corner, first)
            add(middle, first + corner)
            add(middle, second - corner)
            add(middle + corner, second)
            add(port.landing - corner, second)
            add(port.landing, second + corner)
        }
        else -> {
            // Outer routes turn first so each inner route remains inside its neighbor's landing.
            val turn = sharedStart + rise * (.48f - port.index * .12f)
            val diagonal = minOf(16f * unit, travel * .45f, rise * .2f)
            add(port.x, turn)
            add(port.x + diagonal, turn + diagonal)
            add(port.landing, turn + diagonal)
        }
    }
    add(port.landing, end)
    return points
}

/** These branches have fixed geometry; their separate control changes only the underlay's opacity. */
private fun traceOffshoots(width: Float, deckTop: Float, inset: Float, centerY: Float, radius: Float,
    unit: Float): List<List<PreviewTracePoint>> {
    if (radius <= 0f) return emptyList()
    val outer = width / 2f - maxOf(12f * unit, inset / 2f)
    val paths = mutableListOf<List<PreviewTracePoint>>()
    repeat(2) { side ->
        val sign = if (side == 0) -1f else 1f
        fun point(x: Float, y: Float) = PreviewTracePoint(width / 2f + sign * x, y)
        val upperX = radius * .58f
        val upperY = centerY - circleHeight(radius, upperX)
        val upward = minOf(22f * unit, (outer - upperX) * .55f, (upperY - 12f * unit) * .3f)
        if (upward > unit && upperY < deckTop) {
            paths += listOf(point(upperX, upperY), point(upperX + upward, upperY - upward),
                point(upperX + upward, upperY - upward * 2.7f),
                point(upperX + upward * 1.55f, upperY - upward * 3.25f))
        }
        val sideX = radius * .9f
        val sideY = centerY + circleHeight(radius, sideX)
        val outward = minOf(18f * unit, (outer - sideX) * .3f, (deckTop - sideY) * .15f,
            (sideY - 12f * unit) * .5f)
        if (outward > unit) {
            paths += listOf(point(sideX, sideY), point(sideX + outward, sideY + outward * .45f),
                point(outer - outward * .3f, sideY + outward * .45f), point(outer, sideY - outward * .2f))
        }
    }
    return paths
}

private fun List<PreviewTracePoint>.withoutRepeatedPoints(): List<PreviewTracePoint> =
    filterIndexed { index, point -> index == 0 || point != this[index - 1] }
