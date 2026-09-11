package com.arthack.agentvoice

import android.util.AtomicFile
import androidx.compose.runtime.*
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

internal val previewStates = previewModes + "thinking"

internal data class PersonaPreviewState(
    val placement: PersonaPlacement = defaultPortraitLayout().placement,
    val saved: PersonaPlacement = placement,
    val mode: String = "speaking",
    val connection: String = "connected",
    val connectionPreview: String = "off",
    val holding: Boolean = false,
    val revision: Int = 0,
    val design: PreviewDesign = defaultPortraitLayout().design,
    val savedDesign: PreviewDesign = design,
    val halo: PreviewHalo = defaultPortraitLayout().halo,
    val savedHalo: PreviewHalo = halo,
    val spirit: PreviewSpirit = defaultPortraitLayout().spirit,
    val savedSpirit: PreviewSpirit = spirit,
    val activity: String = "steady",
    val micMuted: Boolean = mode != "listening" || holding,
    val speakerMuted: Boolean = false,
    val orientation: String = "portrait",
    val orientationEpoch: Int = 0,
    val personaSide: String = "left",
    val savedPersonaSide: String = personaSide,
    val otherLayout: PreviewLayout = PreviewSharedAppearance.from(PreviewLayout(placement, design, halo, spirit)).applyTo(defaultLandscapeLayout()).let { it.copy(design = it.design.copy(spacing = design.spacing)) },
    val savedOtherLayout: PreviewLayout = otherLayout,
    val theme: String = "bright",
    val mutedPresence: String = "tide",
    val mutedTuning: PreviewMutedTuning = PreviewMutedTuning(),
    val presenceScope: String = "any-muted",
    val horizontalOffsetDp: Int = 0,
    val savedHorizontalOffsetDp: Int = horizontalOffsetDp,
    val appearanceOverrides: Set<String> = emptySet(),
    val savedAppearanceOverrides: Set<String> = appearanceOverrides,
    val remainingLayouts: Map<String, PreviewLayout> = if (orientation in setOf(previewPortrait, previewLandscape)) {
        val shared = PreviewSharedAppearance.from(PreviewLayout(placement, design, halo, spirit, personaSide))
        mapOf(previewPortraitReverse to shared.applyTo(defaultPortraitReverseLayout()).let { it.copy(design = it.design.copy(spacing = design.spacing)) },
            previewLandscapeReverse to shared.applyTo(defaultLandscapeReverseLayout()).let { it.copy(design = it.design.copy(spacing = design.spacing)) })
    } else mapOf(previewPortrait to defaultPortraitLayout(), previewLandscape to defaultLandscapeLayout()),
    val savedRemainingLayouts: Map<String, PreviewLayout> = remainingLayouts,
    val sharedAppearance: PreviewSharedAppearance = PreviewSharedAppearance.from(
        PreviewLayout(placement, design, halo, spirit, personaSide)),
    val savedSharedAppearance: PreviewSharedAppearance = sharedAppearance,
    val showPushToTalk: Boolean = true,
    val icons: PreviewIcons = PreviewIcons(),
    val launcher: String = "current",
    val connectionStyle: String = "relay",
    val sounds: PreviewSounds = PreviewSounds(),
    val savedSounds: PreviewSounds = sounds,
    val savedAppearance: DesignAppearance = DesignAppearance(theme, mutedPresence, mutedTuning, presenceScope, showPushToTalk, icons, launcher, connectionStyle),
) {
    init { require(launcher in previewLaunchers)
        require(connectionStyle in previewConnectionStyles)
        require(theme in previewThemes && mutedPresence in previewMutedPresences && presenceScope in previewPresenceScopes)
        require(horizontalOffsetDp in -200..200 && savedHorizontalOffsetDp in -200..200)
        require(appearanceOverrides.all { it in previewAppearanceGroups } && savedAppearanceOverrides.all { it in previewAppearanceGroups })
        require(orientation in previewOrientations)
        require(remainingLayouts.keys == oppositePreviewOrientations(orientation))
        require(savedRemainingLayouts.keys == oppositePreviewOrientations(orientation)) }
    fun appearance() = DesignAppearance(theme, mutedPresence, mutedTuning, presenceScope, showPushToTalk, icons, launcher, connectionStyle)
    fun withAppearance(value: DesignAppearance) = copy(theme = value.theme, mutedPresence = value.mutedPresence,
        mutedTuning = value.mutedTuning, presenceScope = value.presenceScope, showPushToTalk = value.showPushToTalk,
        icons = value.icons, launcher = value.launcher, connectionStyle = value.connectionStyle)

    fun activeLayout() = PreviewLayout(placement, design, halo, spirit, personaSide, horizontalOffsetDp, appearanceOverrides)
    fun savedLayout() = PreviewLayout(saved, savedDesign, savedHalo, savedSpirit, savedPersonaSide, savedHorizontalOffsetDp, savedAppearanceOverrides)
    fun layouts(): Map<String, PreviewLayout> = remainingLayouts + mapOf(
        orientation to activeLayout(), facingPreviewOrientation(orientation) to otherLayout)
    fun savedLayouts(): Map<String, PreviewLayout> = savedRemainingLayouts + mapOf(
        orientation to savedLayout(), facingPreviewOrientation(orientation) to savedOtherLayout)

    internal fun withLayoutMaps(current: Map<String, PreviewLayout>, savedValues: Map<String, PreviewLayout>, next: String = orientation): PersonaPreviewState {
        require(current.keys == previewOrientations && savedValues.keys == previewOrientations && next in previewOrientations)
        val active = current.getValue(next)
        val savedActive = savedValues.getValue(next)
        return copy(orientation = next,
            placement = active.placement, design = active.design, halo = active.halo, spirit = active.spirit,
            personaSide = active.personaSide, horizontalOffsetDp = active.horizontalOffsetDp, appearanceOverrides = active.appearanceOverrides,
            saved = savedActive.placement, savedDesign = savedActive.design, savedHalo = savedActive.halo,
            savedSpirit = savedActive.spirit, savedPersonaSide = savedActive.personaSide,
            savedHorizontalOffsetDp = savedActive.horizontalOffsetDp, savedAppearanceOverrides = savedActive.appearanceOverrides,
            otherLayout = current.getValue(facingPreviewOrientation(next)),
            savedOtherLayout = savedValues.getValue(facingPreviewOrientation(next)),
            remainingLayouts = current.filterKeys { it in oppositePreviewOrientations(next) },
            savedRemainingLayouts = savedValues.filterKeys { it in oppositePreviewOrientations(next) })
    }

    fun rotate(next: String): PersonaPreviewState {
        require(next in previewOrientations)
        if (next == orientation) return this
        val released = endHold()
        return released.withLayoutMaps(released.layouts(), released.savedLayouts(), next)
            .copy(orientationEpoch = orientationEpoch + 1, revision = released.revision + 1)
    }
    fun withSavedLayouts(portrait: PreviewLayout, landscape: PreviewLayout, shared: PreviewSharedAppearance = sharedAppearance,
        portraitReverse: PreviewLayout = portrait, landscapeReverse: PreviewLayout = landscape): PersonaPreviewState {
        val spacing = portrait.design.spacing
        val values = mapOf(previewPortrait to portrait, previewLandscape to landscape,
            previewPortraitReverse to portraitReverse, previewLandscapeReverse to landscapeReverse).mapValues { (_, layout) ->
            shared.applyTo(layout.copy(design = layout.design.copy(spacing = spacing)))
        }
        return withLayoutMaps(layouts(), values).copy(savedSharedAppearance = shared)
    }
    fun withEffectiveLayout(active: PreviewLayout) = copy(placement = active.placement, design = active.design,
        halo = active.halo, spirit = active.spirit, personaSide = active.personaSide,
        horizontalOffsetDp = active.horizontalOffsetDp, appearanceOverrides = active.appearanceOverrides)

    fun applyAppearance(requested: PreviewLayout): PersonaPreviewState {
        val previous = activeLayout()
        val added = requested.appearanceOverrides - previous.appearanceOverrides
        val routing = if ("traces" in added) previous.design.traces else requested.design.traces
        val snapshot = requested.copy(design = requested.design.copy(traces = routing.copy(
            glowPercent = if ("glow" in added) previous.design.traces.glowPercent else requested.design.traces.glowPercent)),
            halo = if ("halo" in added) previous.halo.copy(containedSizePercent = requested.halo.containedSizePercent) else requested.halo,
            spirit = if ("spirit" in added) previous.spirit else requested.spirit)
        val shared = sharedAppearance.editedBy(previous, snapshot)
        val effective = (layouts() + (orientation to snapshot)).mapValues { (_, layout) ->
            shared.applyTo(layout).let { it.copy(design = it.design.copy(spacing = requested.design.spacing)) }
        }
        return withLayoutMaps(effective, savedLayouts()).copy(sharedAppearance = shared)
    }

    fun json(): JSONObject = JSONObject().put("protocol", 30).put("connectionPreview", connectionPreview).put("launcher", launcher)
        .put("connectionStyle", connectionStyle).put("showPushToTalk", showPushToTalk).put("icons", icons.json())
        .put("savedAppearance", savedAppearance.json()).put("defaultAppearance", shippingAppearance().json())
        .put("sounds", sounds.json()).put("savedSounds", savedSounds.json()).put("defaultSounds", ShippingDesign.sounds.json())
        .put("horizontalOffsetDp", horizontalOffsetDp).put("savedHorizontalOffsetDp", savedHorizontalOffsetDp).put("defaultHorizontalOffsetDp", defaultPreviewLayout(orientation).horizontalOffsetDp)
        .put("appearanceOverrides", appearanceOverrides.appearanceJson()).put("savedAppearanceOverrides", savedAppearanceOverrides.appearanceJson())
        .put("sharedAppearance", sharedAppearance.json()).put("savedSharedAppearance", savedSharedAppearance.json())
        .put("defaultSharedAppearance", PreviewSharedAppearance.from(defaultPortraitLayout()).json())
        .put("theme", theme).put("mutedPresence", mutedPresence).put("mutedTuning", mutedTuning.json()).put("presenceScope", presenceScope)
        .put("orientation", orientation).put("orientationEpoch", orientationEpoch)
        .put("personaSide", personaSide).put("savedPersonaSide", savedPersonaSide).put("defaultPersonaSide", defaultPreviewLayout(orientation).personaSide)
        .put("otherLayout", otherLayout.json()).put("savedOtherLayout", savedOtherLayout.json())
        .put("remainingLayouts", remainingLayouts.previewLayoutsJson()).put("savedRemainingLayouts", savedRemainingLayouts.previewLayoutsJson())
        .put("connection", connection).put("revision", revision)
        .put("mode", mode).put("activity", activity).put("holding", holding).put("scales", placement.scalesJson())
        .put("savedScales", saved.scalesJson()).put("defaults", defaultPreviewLayout(orientation).placement.scalesJson())
        .put("verticalOffsetDp", placement.offsetY.value.roundToInt())
        .put("savedVerticalOffsetDp", saved.offsetY.value.roundToInt())
        .put("defaultVerticalOffsetDp", defaultPreviewLayout(orientation).placement.offsetY.value.roundToInt())
        .put("design", design.json()).put("savedDesign", savedDesign.json()).put("defaultDesign", defaultPreviewLayout(orientation).design.json())
        .put("halo", halo.json()).put("savedHalo", savedHalo.json()).put("defaultHalo", defaultPreviewLayout(orientation).halo.json())
        .put("spirit", spirit.json()).put("savedSpirit", savedSpirit.json()).put("defaultSpirit", defaultPreviewLayout(orientation).spirit.json())
        .put("micMuted", micMuted).put("speakerMuted", speakerMuted)

    fun select(next: String) = copy(mode = next, holding = false, micMuted = next != "listening", speakerMuted = false, revision = revision + 1)

    fun toggle(target: String): PersonaPreviewState = if (connection != "connected") this else when (target) {
        "mic" -> copy(micMuted = !micMuted, holding = false,
            mode = if (mode == "thinking") mode else if (micMuted) "listening" else if (mode == "speaking") "speaking" else "idle", revision = revision + 1)
        "speaker" -> copy(speakerMuted = !speakerMuted, holding = false,
            mode = if (mode == "thinking") mode else if (speakerMuted) "speaking" else if (!micMuted) "listening" else "idle", revision = revision + 1)
        else -> error("Unknown channel")
    }

    fun beginHold() = if (connection == "connected" && micMuted && showPushToTalk) copy(mode = if (mode == "thinking") mode else "listening", holding = true, revision = revision + 1) else this
    fun endHold() = if (holding) copy(mode = if (mode == "thinking") mode else "idle", micMuted = true, holding = false, revision = revision + 1) else this

    fun ui(): CallUi {
        val connected = connection == "connected"
        return CallUi(running = connection != "disconnected" && connection != "failed", connected = connected,
            phase = when (connection) { "connecting" -> "Connecting"; "disconnected" -> "Disconnected"; "failed" -> "Connection failed"; else -> "Connected" },
            message = if (connection == "failed") "Could not reach the server. Check your server and Tailscale, then try again." else null,
            micMuted = micMuted, micOpen = connected && (!micMuted || holding), speakerMuted = speakerMuted,
            speakerOpen = connected && !speakerMuted, canHold = connected && micMuted && showPushToTalk, holding = connected && holding,
            outputLevel = if (connected && mode == "speaking" && !speakerMuted) .14f else 0f,
            codingActivity = if (connected && mode == "thinking") CodingActivity.Working else CodingActivity.Idle)
    }
}

private fun String.previewOrientationJsonKey(): String = when (this) {
    previewPortrait -> "portrait"
    previewLandscape -> "landscape"
    previewPortraitReverse -> "portraitReverse"
    previewLandscapeReverse -> "landscapeReverse"
    else -> error("Unknown preview orientation")
}

private fun Map<String, PreviewLayout>.previewLayoutsJson(): JSONObject = JSONObject().also { data ->
    for ((orientation, layout) in this) data.put(orientation.previewOrientationJsonKey(), layout.json())
}

private fun decodeRemainingLayouts(data: JSONObject, orientation: String, version: Int): Map<String, PreviewLayout> {
    val expected = oppositePreviewOrientations(orientation)
    require(data.fields() == expected.map { it.previewOrientationJsonKey() }.toSet())
    return expected.associateWith { decodePreviewLayout(data.getJSONObject(it.previewOrientationJsonKey()), version) }
}

private fun decodeSavedActiveLayout(data: JSONObject, legacyWingspan: Boolean): PreviewLayout = PreviewLayout(
    decodePreviewScales(data.getJSONObject("savedScales")).copy(offsetY = decodePreviewOffset(data.get("savedVerticalOffsetDp")).dp),
    decodePreviewDesign(data.getJSONObject("savedDesign")),
    decodePreviewHalo(data.getJSONObject("savedHalo"), legacyWingspan),
    decodePreviewSpirit(data.getJSONObject("savedSpirit")),
    data.getString("savedPersonaSide"),
    decodePreviewOffset(data.get("savedHorizontalOffsetDp")),
    decodeAppearanceOverrides(data.getJSONArray("savedAppearanceOverrides")),
)

internal fun restorePersonaPreview(data: JSONObject, saved: PersonaPlacement, savedDesign: PreviewDesign = PreviewDesign(), savedHalo: PreviewHalo = PreviewHalo(), savedSpirit: PreviewSpirit = PreviewSpirit(), savedLandscape: PreviewLayout = PreviewLayout(), savedPortraitSide: String = "left", savedHorizontalOffsetDp: Int = 0, savedOverrides: Set<String> = emptySet(),
    savedShared: PreviewSharedAppearance = PreviewSharedAppearance.from(PreviewLayout(saved, savedDesign, savedHalo, savedSpirit, savedPortraitSide)),
    savedSounds: PreviewSounds = PreviewSounds(), savedAppearance: DesignAppearance = DesignAppearance()): PersonaPreviewState {
    val mode = data.getString("mode")
    val revision = data.get("revision")
    require(mode in previewStates && revision is Int && revision >= 0)
    val holding = data.getBoolean("holding")
    val connection = data.optString("connection", "connected")
    require(connection in previewConnections)
    val activity = data.optString("activity", "steady")
    require(activity in previewActivities)
    val orientation = data.optString("orientation", "portrait").also { require(it in previewOrientations) }
    val epoch = data.optInt("orientationEpoch", 0).also { require(it >= 0) }
    val protocol = data.optInt("protocol", 10)
    require(protocol in 1..30)
    if (protocol <= 26) require(orientation in setOf(previewPortrait, previewLandscape))
    if (protocol >= 22) {
        decodeDesignAppearance(data.getJSONObject("savedAppearance"), legacy = protocol == 22,
            legacyConnectionStyle = protocol <= 28)
        decodeDesignAppearance(data.getJSONObject("defaultAppearance"), legacy = protocol == 22,
            legacyConnectionStyle = protocol <= 28)
    }
    if (protocol >= 18) {
        decodePreviewSounds(data.getJSONObject("savedSounds"))
        decodePreviewSounds(data.getJSONObject("defaultSounds"))
    }
    val base = PersonaPreviewState(placement = decodePreviewPlacement(data), saved = saved,
        mode = if (holding) "idle" else mode, connection = connection, revision = revision, activity = activity,
        design = data.optJSONObject("design")?.let {
            if (protocol in 3..11) decodePersonaDesign(JSONObject().put("version", protocol).put("design", it).toString())
            else {
                val spaced = if (protocol <= 13) withVersionTwelvePadding(it) else it
                val migrated = if (protocol <= 15) withLegacyTraceJoin(spaced) else if (protocol <= 18) withoutLegacyOffshoots(spaced) else spaced
                if (protocol <= 19) decodeLegacyControlExtentDesign(migrated) else decodePreviewDesign(migrated)
            }
        } ?: PreviewDesign(), savedDesign = savedDesign,
        halo = data.optJSONObject("halo")?.let { decodePreviewHalo(it, legacyWingspan = protocol <= 29) } ?: PreviewHalo(), savedHalo = savedHalo,
        spirit = data.optJSONObject("spirit")?.let(::decodePreviewSpirit) ?: PreviewSpirit(), savedSpirit = savedSpirit,
        micMuted = holding || data.optBoolean("micMuted", mode != "listening"), speakerMuted = data.optBoolean("speakerMuted", false),
        orientation = orientation, orientationEpoch = epoch,
        personaSide = data.optString("personaSide", "left").also { require(it in previewPersonaSides) },
        otherLayout = data.optJSONObject("otherLayout")?.let { decodePreviewLayout(it, if (protocol >= 30) 23 else if (protocol >= 20) 18 else if (protocol >= 19) 17 else if (protocol >= 17) 16 else if (protocol >= 16) 14 else if (protocol >= 14) 13 else if (protocol == 13) 12 else protocol) } ?: PreviewLayout(),
        theme = data.optString("theme", "bright"), mutedPresence = data.optString("mutedPresence", "tide"),
        mutedTuning = if (protocol >= 13) decodePreviewMutedTuning(data.getJSONObject("mutedTuning")) else PreviewMutedTuning(),
        presenceScope = if (protocol >= 15) data.getString("presenceScope") else "any-muted",
        horizontalOffsetDp = if (protocol >= 17) decodePreviewOffset(data.get("horizontalOffsetDp")) else 0,
        appearanceOverrides = if (protocol >= 17) decodeAppearanceOverrides(data.getJSONArray("appearanceOverrides")) else emptySet(),
        launcher = if (protocol >= 23) data.getString("launcher").also { require(it in previewLaunchers) } else "current",
        connectionStyle = if (protocol >= 29) data.getString("connectionStyle").also { require(it in previewConnectionStyles) } else "relay",
        icons = if (protocol >= 21) decodePreviewIcons(data.getJSONObject("icons")) else PreviewIcons(),
        showPushToTalk = if (protocol >= 19) decodePreviewBoolean(data.get("showPushToTalk")) else true,
        sounds = if (protocol >= 18) decodePreviewSounds(data.getJSONObject("sounds")) else PreviewSounds(),
        savedSounds = savedSounds, savedAppearance = savedAppearance)
    val restored = if (protocol >= 27) base.copy(
        remainingLayouts = decodeRemainingLayouts(data.getJSONObject("remainingLayouts"), orientation, if (protocol >= 30) 23 else 22),
        savedRemainingLayouts = decodeRemainingLayouts(data.getJSONObject("savedRemainingLayouts"), orientation, if (protocol >= 30) 23 else 22),
    ) else base
    val currentValues = if (protocol >= 27) restored.layouts() else {
        val portrait = if (orientation == previewPortrait) restored.activeLayout() else restored.otherLayout
        val landscape = if (orientation == previewLandscape) restored.activeLayout() else restored.otherLayout
        mapOf(previewPortrait to portrait, previewLandscape to landscape,
            previewPortraitReverse to portrait, previewLandscapeReverse to landscape)
    }
    val portrait = currentValues.getValue(previewPortrait)
    val landscape = currentValues.getValue(previewLandscape)
    val shared = if (protocol >= 17) decodeSharedAppearance(data.getJSONObject("sharedAppearance"), legacyOffshoots = protocol <= 18, legacyWingspan = protocol <= 29) else PreviewSharedAppearance.from(portrait)
    val scopedLandscape = if (protocol >= 17) landscape else landscape.copy(appearanceOverrides = legacyLandscapeOverrides(landscape, shared))
    if (protocol >= 19) require(currentValues.values.all { it.design.spacing == portrait.design.spacing })
    val migratedLandscape = if (protocol >= 19) scopedLandscape else scopedLandscape.copy(design = scopedLandscape.design.copy(spacing = portrait.design.spacing))
    val migratedValues = currentValues + (previewLandscape to migratedLandscape) +
        (previewLandscapeReverse to if (protocol >= 27) currentValues.getValue(previewLandscapeReverse) else migratedLandscape)
    val effectiveValues = migratedValues.mapValues { (_, layout) -> shared.applyTo(layout) }
    if (protocol >= 17) {
        fun expected(layout: PreviewLayout) = if (protocol >= 19) layout else layout.copy(design = layout.design.copy(spacing = portrait.design.spacing))
        require(effectiveValues.all { (slot, layout) -> layout == expected(migratedValues.getValue(slot)) })
    }
    val savedValues = if (protocol >= 27) {
        val savedActive = decodeSavedActiveLayout(data, legacyWingspan = protocol <= 29)
        val savedCurrent = restored.savedRemainingLayouts + mapOf(orientation to savedActive,
            facingPreviewOrientation(orientation) to decodePreviewLayout(data.getJSONObject("savedOtherLayout"), if (protocol >= 30) 23 else 22))
        val savedBase = decodeSharedAppearance(data.getJSONObject("savedSharedAppearance"), legacyWingspan = protocol <= 29)
        require(savedCurrent.values.all { it.design.spacing == savedCurrent.getValue(previewPortrait).design.spacing })
        require(savedCurrent.values.all { savedBase.applyTo(it) == it })
        savedCurrent
    } else mapOf(
        previewPortrait to PreviewLayout(saved, savedDesign, savedHalo, savedSpirit, savedPortraitSide, savedHorizontalOffsetDp, savedOverrides),
        previewLandscape to savedLandscape,
        previewPortraitReverse to PreviewLayout(saved, savedDesign, savedHalo, savedSpirit, savedPortraitSide, savedHorizontalOffsetDp, savedOverrides),
        previewLandscapeReverse to savedLandscape,
    ).mapValues { (_, layout) -> savedShared.applyTo(layout.copy(design = layout.design.copy(spacing = savedDesign.spacing))) }
    return restored.withLayoutMaps(effectiveValues, savedValues).copy(sharedAppearance = shared,
        savedSharedAppearance = if (protocol >= 27) decodeSharedAppearance(data.getJSONObject("savedSharedAppearance"), legacyWingspan = protocol <= 29) else savedShared,
        savedSounds = if (protocol >= 27) decodePreviewSounds(data.getJSONObject("savedSounds")) else savedSounds,
        savedAppearance = if (protocol >= 27) decodeDesignAppearance(data.getJSONObject("savedAppearance"),
            legacyConnectionStyle = protocol <= 28) else savedAppearance)
}

internal class PersonaPreviewSession(initial: PersonaPlacement, private val selection: File, initialDesign: PreviewDesign = defaultPortraitLayout().design, initialHalo: PreviewHalo = defaultPortraitLayout().halo, initialSpirit: PreviewSpirit = defaultPortraitLayout().spirit, initialLandscape: PreviewLayout = defaultLandscapeLayout(), initialPortraitSide: String = "left", initialHorizontalOffsetDp: Int = 0,
    initialOverrides: Set<String> = emptySet(), initialShared: PreviewSharedAppearance? = null,
    initialSounds: PreviewSounds = PreviewSounds(), persistDesign: ((String) -> Unit)? = null,
    initialPortraitReverse: PreviewLayout = defaultPortraitReverseLayout(),
    initialLandscapeReverse: PreviewLayout = defaultLandscapeReverseLayout()) {
    private val shared = initialShared ?: PreviewSharedAppearance.from(PreviewLayout(initial, initialDesign, initialHalo, initialSpirit))
    private val spacedLandscape = initialLandscape.copy(design = initialLandscape.design.copy(spacing = initialDesign.spacing))
    private val landscape = shared.applyTo(if (initialShared == null) spacedLandscape.copy(
        appearanceOverrides = spacedLandscape.appearanceOverrides + legacyLandscapeOverrides(spacedLandscape, shared)) else spacedLandscape)
    private val portraitReverse = shared.applyTo(initialPortraitReverse.copy(design = initialPortraitReverse.design.copy(spacing = initialDesign.spacing)))
    private val landscapeReverse = shared.applyTo(initialLandscapeReverse.copy(design = initialLandscapeReverse.design.copy(spacing = initialDesign.spacing)))
    private var currentState by mutableStateOf(PersonaPreviewState(placement = initial, design = initialDesign, halo = initialHalo,
        spirit = initialSpirit, otherLayout = landscape, personaSide = initialPortraitSide,
        horizontalOffsetDp = initialHorizontalOffsetDp, appearanceOverrides = initialOverrides, sharedAppearance = shared,
        remainingLayouts = mapOf(previewPortraitReverse to portraitReverse, previewLandscapeReverse to landscapeReverse),
        savedRemainingLayouts = mapOf(previewPortraitReverse to portraitReverse, previewLandscapeReverse to landscapeReverse),
        sounds = initialSounds))

    var persistWorkingDesign: ((String) -> Unit)? = persistDesign
    var state: PersonaPreviewState
        get() = currentState
        set(value) {
            if (persistWorkingDesign != null && value.designProfile() != currentState.designProfile()) persistWorkingDesign?.invoke(value.designProfile())
            currentState = value
        }

    var showIconCredits by mutableStateOf(false)

    private fun checkOrientation(request: JSONObject) {
        check(request.getString("orientation") == state.orientation && request.get("orientationEpoch") == state.orientationEpoch) {
            "Phone rotated. Review the visible orientation before editing."
        }
    }
    suspend fun command(request: JSONObject): JSONObject {
        val method = request.getString("method")
        var profile: String? = null
        if (method == "save") {
            require(request.fields() == setOf("id", "method", "revision", "orientation", "orientationEpoch"))
            val selected = withContext(Dispatchers.Main) {
                checkOrientation(request)
                check(request.get("revision") == state.revision) { "Preview changed. Review it before saving." }
                state
            }
            val layouts = selected.layouts()
            val portrait = layouts.getValue(previewPortrait)
            val landscape = layouts.getValue(previewLandscape)
            val portraitReverse = layouts.getValue(previewPortraitReverse)
            val landscapeReverse = layouts.getValue(previewLandscapeReverse)
            profile = encodePersonaTuning(portrait.placement, portrait.design, portrait.halo, portrait.spirit, landscape,
                portrait.personaSide, portrait.horizontalOffsetDp, portrait.appearanceOverrides, selected.sharedAppearance,
                selected.sounds, selected.appearance(), portraitReverse, landscapeReverse)
            savePersonaTuning(selection, profile)
            withContext(Dispatchers.Main) { state = state.withSavedLayouts(portrait, landscape, selected.sharedAppearance,
                portraitReverse, landscapeReverse).copy(savedSounds = selected.sounds, savedAppearance = selected.appearance()) }
        }
        return withContext(Dispatchers.Main) {
            when (method) {
                "get" -> require(request.fields() == setOf("id", "method"))
                "preview" -> {
                    require(request.fields() == setOf("id", "method", "connection", "mode", "scales", "verticalOffsetDp", "design", "halo", "spirit", "activity", "orientation", "orientationEpoch", "personaSide", "theme", "mutedPresence", "mutedTuning", "presenceScope", "horizontalOffsetDp", "appearanceOverrides", "sounds", "showPushToTalk", "icons", "launcher", "connectionStyle"))
                    checkOrientation(request)
                    val side = request.getString("personaSide").also { require(it in previewPersonaSides) }
                    val mode = request.getString("mode")
                    require(mode in previewStates)
                    val connection = request.getString("connection")
                    require(connection in previewConnections)
                    val placement = decodePreviewPlacement(request)
                    val design = decodePreviewDesign(request.getJSONObject("design"))
                    val halo = decodePreviewHalo(request.getJSONObject("halo"))
                    val spirit = decodePreviewSpirit(request.getJSONObject("spirit"))
                    val activity = request.getString("activity")
                    require(activity in previewActivities)
                    val theme = request.getString("theme").also { require(it in previewThemes) }
                    val mutedPresence = request.getString("mutedPresence").also { require(it in previewMutedPresences) }
                    val mutedTuning = decodePreviewMutedTuning(request.getJSONObject("mutedTuning"))
                    val presenceScope = request.getString("presenceScope").also { require(it in previewPresenceScopes) }
                    val horizontal = decodePreviewOffset(request.get("horizontalOffsetDp"))
                    val overrides = decodeAppearanceOverrides(request.getJSONArray("appearanceOverrides"))
                    val launcher = request.getString("launcher").also { require(it in previewLaunchers) }
                    val connectionStyle = request.getString("connectionStyle").also { require(it in previewConnectionStyles) }
                    val showPushToTalk = decodePreviewBoolean(request.get("showPushToTalk"))
                    val sounds = decodePreviewSounds(request.getJSONObject("sounds"))
                    val icons = decodePreviewIcons(request.getJSONObject("icons"))
                    val next = if (mode != state.mode) state.select(mode) else state.endHold()
                    state = next.applyAppearance(PreviewLayout(placement, design, halo, spirit, side, horizontal, overrides)).copy(
                        activity = activity, connection = connection, theme = theme, mutedPresence = mutedPresence,
                        mutedTuning = mutedTuning, presenceScope = presenceScope, sounds = sounds, showPushToTalk = showPushToTalk,
                        icons = icons, launcher = launcher, connectionStyle = connectionStyle, revision = state.revision + 1)
                }
                "resetProduction" -> {
                    require(request.fields() == setOf("id", "method", "revision", "orientation", "orientationEpoch"))
                    checkOrientation(request)
                    check(request.get("revision") == state.revision) { "Preview changed. Review before resetting." }
                    val next = state.withDesignProfile(StudioProduction.profile)
                    // Reset is durable even when the current values already equal production.
                    persistWorkingDesign?.invoke(next.designProfile())
                    state = next
                }
                "connectionPreview" -> {
                    require(request.fields() == setOf("id", "method", "scene", "orientation", "orientationEpoch"))
                    checkOrientation(request)
                    val scene = request.getString("scene")
                    require(scene in setOf("off", "camera") + ConnectionScene.entries.map { it.key })
                    state = state.endHold().copy(connectionPreview = scene)
                }
                "iconCredits" -> {
                    require(request.fields() == setOf("id", "method"))
                    state = state.endHold()
                    showIconCredits = true
                }
                "save" -> Unit
                else -> error("Unknown preview command")
            }
            JSONObject().put("state", state.json()).also { if (profile != null) it.put("profile", profile) }
        }
    }
}

internal fun decodePreviewBoolean(value: Any): Boolean { require(value is Boolean); return value }
