package com.arthack.agentvoice

import org.json.JSONArray
import org.json.JSONObject

internal val previewAppearanceGroups = setOf("glow", "halo", "spirit", "traces")

/** Sizes and placement never belong to shared appearance. Internal excluded fields use fixed sentinels. */
internal data class PreviewSharedAppearance(
    val traces: PreviewTraces,
    val glowPercent: Int,
    val halo: PreviewHalo,
    val spirit: PreviewSpirit,
) {
    init {
        require(traces.glowPercent == 0 && halo.containedSizePercent == 78 && glowPercent in 0..100)
    }
    fun json() = JSONObject().put("traces", traces.json().also { it.remove("glowPercent") })
        .put("glowPercent", glowPercent).put("halo", halo.json().also { it.remove("containedSizePercent") })
        .put("spirit", spirit.json())

    fun applyTo(layout: PreviewLayout): PreviewLayout {
        val overrides = layout.appearanceOverrides
        val routing = if ("traces" in overrides) layout.design.traces else traces
        return layout.copy(design = layout.design.copy(traces = routing.copy(
            glowPercent = if ("glow" in overrides) layout.design.traces.glowPercent else glowPercent)),
            halo = if ("halo" in overrides) layout.halo else halo.copy(containedSizePercent = layout.halo.containedSizePercent),
            spirit = if ("spirit" in overrides) layout.spirit else spirit)
    }

    fun editedBy(previous: PreviewLayout, requested: PreviewLayout): PreviewSharedAppearance {
        val incoming = from(requested)
        fun shared(group: String) = group !in previous.appearanceOverrides && group !in requested.appearanceOverrides
        return copy(traces = if (shared("traces")) incoming.traces else traces,
            glowPercent = if (shared("glow")) incoming.glowPercent else glowPercent,
            halo = if (shared("halo")) incoming.halo else halo,
            spirit = if (shared("spirit")) incoming.spirit else spirit)
    }

    companion object {
        fun from(layout: PreviewLayout) = PreviewSharedAppearance(layout.design.traces.copy(glowPercent = 0),
            layout.design.traces.glowPercent, layout.halo.copy(containedSizePercent = 78), layout.spirit)
    }
}

internal fun decodeSharedAppearance(data: JSONObject): PreviewSharedAppearance {
    require(data.fields() == setOf("traces", "glowPercent", "halo", "spirit"))
    val traces = JSONObject(data.getJSONObject("traces").toString())
    require(!traces.has("glowPercent"))
    val halo = JSONObject(data.getJSONObject("halo").toString())
    require(!halo.has("containedSizePercent"))
    val routing = decodePreviewTraces(traces.put("glowPercent", 0))
    val glow = data.get("glowPercent")
    require(glow is Number && glow.toDouble() % 1.0 == 0.0 && glow.toDouble() in 0.0..100.0)
    return PreviewSharedAppearance(routing, glow.toInt(), decodePreviewHalo(halo.put("containedSizePercent", 78)),
        decodePreviewSpirit(data.getJSONObject("spirit")))
}

internal fun decodeAppearanceOverrides(data: JSONArray): Set<String> {
    val values = (0 until data.length()).map { data.get(it).also { value -> require(value is String) } as String }
    require(values == values.distinct().sorted() && values.all { it in previewAppearanceGroups })
    return values.toSet()
}

internal fun Set<String>.appearanceJson() = JSONArray(toList().sorted())

internal fun legacyLandscapeOverrides(layout: PreviewLayout, shared: PreviewSharedAppearance): Set<String> {
    val appearance = PreviewSharedAppearance.from(layout)
    val baseline = PreviewSharedAppearance.from(PreviewLayout())
    return buildSet {
        if (appearance.traces != baseline.traces && appearance.traces != shared.traces) add("traces")
        if (appearance.glowPercent != baseline.glowPercent && appearance.glowPercent != shared.glowPercent) add("glow")
        if (appearance.halo != baseline.halo && appearance.halo != shared.halo) add("halo")
        if (appearance.spirit != baseline.spirit && appearance.spirit != shared.spirit) add("spirit")
    }
}

internal data class PreviewProfileLayouts(val portrait: PreviewLayout, val landscape: PreviewLayout,
    val shared: PreviewSharedAppearance)

internal fun decodePreviewProfileLayouts(json: String): PreviewProfileLayouts {
    val data = JSONObject(json)
    val version = data.getInt("version")
    val portrait = PreviewLayout(decodePersonaTuning(json), decodePersonaDesign(json), decodePersonaHalo(json),
        decodePersonaSpirit(json), decodePortraitSide(json),
        if (version >= 15) decodePreviewOffset(data.get("horizontalOffsetDp")) else 0,
        if (version >= 15) decodeAppearanceOverrides(data.getJSONArray("appearanceOverrides")) else emptySet())
    val storedLandscape = decodeStoredLandscapeLayout(json)
    val shared = if (version >= 15) decodeSharedAppearance(data.getJSONObject("sharedAppearance"))
        else PreviewSharedAppearance.from(portrait)
    val landscape = if (version >= 15) storedLandscape else storedLandscape.copy(
        appearanceOverrides = legacyLandscapeOverrides(storedLandscape, shared))
    if (version >= 15) {
        require(shared.applyTo(portrait) == portrait && shared.applyTo(landscape) == landscape)
    }
    return PreviewProfileLayouts(shared.applyTo(portrait), shared.applyTo(landscape), shared)
}
