package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal val previewOrientations = setOf("portrait", "landscape")
internal val previewPersonaSides = setOf("left", "right")
internal val previewThemes = setOf("bright", "quiet", "grayscale")
internal val previewPresenceScopes = setOf("both-muted", "any-muted", "always")
internal val previewMutedPresences = setOf("tide", "off", "words", "channels", "labeled", "contacts")

/** Only the activity observes orientation; a host request can never select it. */
internal data class PreviewLayout(
    val placement: PersonaPlacement = PersonaPlacement(offsetY = 0.dp),
    val design: PreviewDesign = PreviewDesign(),
    val halo: PreviewHalo = PreviewHalo(),
    val spirit: PreviewSpirit = PreviewSpirit(),
    val personaSide: String = "left",
    val horizontalOffsetDp: Int = 0,
    val appearanceOverrides: Set<String> = emptySet(),
) {
    init { require(personaSide in previewPersonaSides && horizontalOffsetDp in -200..200)
        require(appearanceOverrides.all { it in previewAppearanceGroups }) }
    fun json(): JSONObject = JSONObject().put("scales", placement.scalesJson())
        .put("verticalOffsetDp", placement.offsetY.value.toInt()).put("design", design.json())
        .put("halo", halo.json()).put("spirit", spirit.json()).put("personaSide", personaSide)
        .put("horizontalOffsetDp", horizontalOffsetDp).put("appearanceOverrides", appearanceOverrides.appearanceJson())
}

/** Provisional studio defaults never change production PersonaPlacement or legacy profile omissions. */
internal fun defaultPortraitLayout() = PreviewLayout(
    placement = PersonaPlacement(.78f, .56f, .78f, (-22).dp),
    design = PreviewDesign(controlsHeightDp = 387, holdSharePercent = 40.9,
        traces = PreviewTraces("parallel", 130, 175, 88, 0), spacing = PreviewSpacing(paddingDp = 16)),
    halo = PreviewHalo(variant = "contained"),
    spirit = PreviewSpirit(persona = "follow"),
)

internal fun defaultLandscapeLayout() = PreviewSharedAppearance.from(defaultPortraitLayout()).applyTo(
    PreviewLayout(design = PreviewDesign(spacing = PreviewSpacing(paddingDp = 16))))

internal fun defaultPreviewLayout(orientation: String): PreviewLayout {
    require(orientation in previewOrientations)
    return if (orientation == "portrait") defaultPortraitLayout() else defaultLandscapeLayout()
}

internal fun decodePreviewLayout(data: JSONObject, version: Int = 15): PreviewLayout {
    require(data.fields() == setOf("scales", "verticalOffsetDp", "design", "halo", "spirit", "personaSide") +
        if (version >= 15) setOf("horizontalOffsetDp", "appearanceOverrides") else emptySet<String>())
    val design = data.getJSONObject("design")
    val spaced = when { version <= 11 -> withLegacyPreviewSpacing(design); version == 12 -> withVersionTwelvePadding(design); else -> design }
    return PreviewLayout(decodePreviewPlacement(data), decodePreviewDesign(if (version <= 13) withLegacyTraceJoin(spaced) else spaced),
        decodePreviewHalo(data.getJSONObject("halo")), decodePreviewSpirit(data.getJSONObject("spirit")), data.getString("personaSide"),
        if (version >= 15) decodePreviewOffset(data.get("horizontalOffsetDp")) else 0,
        if (version >= 15) decodeAppearanceOverrides(data.getJSONArray("appearanceOverrides")) else emptySet())
}

internal fun decodeLandscapeLayout(json: String): PreviewLayout = decodePreviewProfileLayouts(json).landscape

internal fun decodeStoredLandscapeLayout(json: String): PreviewLayout {
    val data = JSONObject(json)
    val version = data.getInt("version")
    require(version in 1..15)
    return if (version >= 11) decodePreviewLayout(data.getJSONObject("landscape"), version) else PreviewLayout()
}

internal fun decodePortraitSide(json: String): String {
    val data = JSONObject(json)
    val version = data.getInt("version")
    require(version in 1..15)
    return (if (version >= 11) data.getString("personaSide") else "left")
        .also { require(it in previewPersonaSides) }
}
