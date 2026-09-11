package com.arthack.agentvoice

import android.content.Context
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.view.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal const val previewPortrait = "portrait"
internal const val previewLandscape = "landscape"
internal const val previewPortraitReverse = "portrait-reverse"
internal const val previewLandscapeReverse = "landscape-reverse"
internal val previewOrientations = setOf(previewPortrait, previewLandscape, previewPortraitReverse, previewLandscapeReverse)
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

/** Studio reset baseline follows the explicitly promoted shipping snapshot. */
internal fun shippingLayoutForOrientation(orientation: String): ShippingLayout = when (orientation) {
    previewPortrait -> ShippingDesign.portrait
    previewLandscape -> ShippingDesign.landscape
    previewPortraitReverse -> ShippingDesign.portraitReverse
    previewLandscapeReverse -> ShippingDesign.landscapeReverse
    else -> error("Unknown preview orientation")
}
internal fun defaultPortraitLayout() = shippingLayoutForOrientation(previewPortrait).previewLayout()
internal fun defaultLandscapeLayout() = shippingLayoutForOrientation(previewLandscape).previewLayout()
internal fun defaultPortraitReverseLayout() = shippingLayoutForOrientation(previewPortraitReverse).previewLayout()
internal fun defaultLandscapeReverseLayout() = shippingLayoutForOrientation(previewLandscapeReverse).previewLayout()
internal fun ShippingLayout.previewLayout() = PreviewLayout(placement, design, halo, spirit, personaSide, horizontalOffsetDp)

internal fun defaultPreviewLayout(orientation: String): PreviewLayout {
    require(orientation in previewOrientations)
    return shippingLayoutForOrientation(orientation).previewLayout()
}

internal fun facingPreviewOrientation(orientation: String): String = when (orientation) {
    previewPortrait -> previewLandscape
    previewLandscape -> previewPortrait
    previewPortraitReverse -> previewLandscapeReverse
    previewLandscapeReverse -> previewPortraitReverse
    else -> error("Unknown preview orientation")
}

internal fun oppositePreviewOrientations(orientation: String): Set<String> {
    require(orientation in previewOrientations)
    return if (orientation == previewPortrait || orientation == previewLandscape)
        setOf(previewPortraitReverse, previewLandscapeReverse)
    else setOf(previewPortrait, previewLandscape)
}

internal fun previewOrientation(configurationOrientation: Int, rotation: Int): String = when (configurationOrientation) {
    Configuration.ORIENTATION_PORTRAIT ->
        if (rotation == Surface.ROTATION_180) previewPortraitReverse else previewPortrait
    Configuration.ORIENTATION_LANDSCAPE ->
        if (rotation == Surface.ROTATION_270) previewLandscapeReverse else previewLandscape
    else -> when (rotation) {
        Surface.ROTATION_90 -> previewLandscape
        Surface.ROTATION_180 -> previewPortraitReverse
        Surface.ROTATION_270 -> previewLandscapeReverse
        else -> previewPortrait
    }
}

/** Observes display rotation because 180-degree turns need not change Configuration.orientation. */
@Composable
internal fun currentPreviewOrientation(): String {
    val configuration = LocalConfiguration.current
    val context = LocalContext.current
    val view = LocalView.current
    val displayManager = remember(context) { context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager }
    val displayId = view.display?.displayId
    var rotation by remember(displayId) { mutableIntStateOf(view.display?.rotation ?: Surface.ROTATION_0) }
    DisposableEffect(displayManager, displayId) {
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(id: Int) = Unit
            override fun onDisplayRemoved(id: Int) = Unit
            override fun onDisplayChanged(id: Int) {
                if (displayId == null || id == displayId) rotation = view.display?.rotation ?: rotation
            }
        }
        displayManager.registerDisplayListener(listener, null)
        onDispose { displayManager.unregisterDisplayListener(listener) }
    }
    return previewOrientation(configuration.orientation, rotation)
}

internal fun decodePreviewLayout(data: JSONObject, version: Int = 23): PreviewLayout {
    require(data.fields() == setOf("scales", "verticalOffsetDp", "design", "halo", "spirit", "personaSide") +
        if (version >= 15) setOf("horizontalOffsetDp", "appearanceOverrides") else emptySet<String>())
    val design = data.getJSONObject("design")
    val spaced = when { version <= 11 -> withLegacyPreviewSpacing(design); version == 12 -> withVersionTwelvePadding(design); else -> design }
    val migrated = if (version <= 13) withLegacyTraceJoin(spaced) else if (version <= 16) withoutLegacyOffshoots(spaced) else spaced
    return PreviewLayout(decodePreviewPlacement(data), if (version <= 17) decodeLegacyControlExtentDesign(migrated) else decodePreviewDesign(migrated),
        decodePreviewHalo(data.getJSONObject("halo"), legacyWingspan = version <= 22), decodePreviewSpirit(data.getJSONObject("spirit")), data.getString("personaSide"),
        if (version >= 15) decodePreviewOffset(data.get("horizontalOffsetDp")) else 0,
        if (version >= 15) decodeAppearanceOverrides(data.getJSONArray("appearanceOverrides")) else emptySet())
}

internal fun decodeLandscapeLayout(json: String): PreviewLayout = decodePreviewProfileLayouts(json).landscape

internal fun decodeStoredLandscapeLayout(json: String): PreviewLayout {
    val data = JSONObject(json)
    val version = data.getInt("version")
    require(version in 1..23)
    return if (version >= 11) decodePreviewLayout(data.getJSONObject("landscape"), version) else PreviewLayout()
}

internal fun decodePortraitSide(json: String): String {
    val data = JSONObject(json)
    val version = data.getInt("version")
    require(version in 1..23)
    return (if (version >= 11) data.getString("personaSide") else "left")
        .also { require(it in previewPersonaSides) }
}
