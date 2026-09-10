package com.arthack.agentvoice

import android.util.AtomicFile
import androidx.compose.runtime.*
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

internal val previewConnections = setOf("connected", "connecting", "disconnected")
internal val previewModes = setOf("speaking", "listening", "idle")
internal fun JSONObject.fields(): Set<String> = keys().asSequence().toSet()

internal fun decodePersonaTuning(json: String): PersonaPlacement {
    val data = JSONObject(json)
    fun scale(values: JSONObject, key: String): Float {
        val value = values.getDouble(key).toFloat()
        require(value.isFinite())
        return value.coerceIn(.35f, 1.2f)
    }
    val placement = when (data.getInt("version")) {
        // Loading never rewrites the original choice; migration happens only on Save.
        1 -> scale(data, "scaleMultiplier").let { PersonaPlacement(it, it, it) }
        2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 -> data.getJSONObject("scaleMultipliers").let {
            PersonaPlacement(scale(it, "speaking"), scale(it, "listening"), scale(it, "idle"))
        }
        else -> error("Unsupported Persona tuning version")
    }
    return if (data.has("verticalOffsetDp")) placement.copy(offsetY = decodePreviewOffset(data.get("verticalOffsetDp")).dp)
        else placement
}

internal fun encodePersonaTuning(placement: PersonaPlacement, design: PreviewDesign = PreviewDesign(), halo: PreviewHalo = PreviewHalo(), spirit: PreviewSpirit = PreviewSpirit(), landscape: PreviewLayout = PreviewLayout(), personaSide: String = "left", horizontalOffsetDp: Int = 0, appearanceOverrides: Set<String> = emptySet(),
    sharedAppearance: PreviewSharedAppearance = PreviewSharedAppearance.from(PreviewLayout(placement, design, halo, spirit, personaSide)),
    sounds: PreviewSounds = PreviewSounds()): String {
    fun percent(scale: Float) = (scale * 100).roundToInt() / 100.0
    return JSONObject()
        .put("version", 18).put("sounds", sounds.json())
        .put("horizontalOffsetDp", horizontalOffsetDp).put("appearanceOverrides", appearanceOverrides.appearanceJson())
        .put("sharedAppearance", sharedAppearance.json())
        .put("landscape", landscape.copy(design = landscape.design.copy(spacing = design.spacing)).json()).put("personaSide", personaSide)
        .put("spirit", spirit.json())
        .put("halo", halo.json())
        .put("design", design.json())
        .put("scaleMultipliers", JSONObject()
            .put("speaking", percent(placement.speakingScale))
            .put("listening", percent(placement.listeningScale))
            .put("idle", percent(placement.idleScale)))
        .put("verticalOffsetDp", placement.offsetY.value.roundToInt())
        .put("connectedArtboardScale", 1.9)
        .put("disconnectedArtboardScale", 1.5)
        .put("savedAtEpochMs", System.currentTimeMillis())
        .toString(2)
}

internal fun savePersonaTuning(file: File, profile: String) {
    val target = AtomicFile(file)
    val stream = target.startWrite()
    try {
        stream.write(profile.toByteArray(Charsets.UTF_8))
        target.finishWrite(stream)
    } catch (failure: Throwable) {
        target.failWrite(stream)
        throw failure
    }
}

internal fun PersonaPlacement.scalesJson() = JSONObject()
    .put("speaking", (speakingScale * 100).roundToInt())
    .put("listening", (listeningScale * 100).roundToInt())
    .put("idle", (idleScale * 100).roundToInt())

internal fun decodePreviewScales(data: JSONObject): PersonaPlacement {
    require(data.fields() == previewModes)
    fun scale(key: String): Float {
        val number = data.get(key)
        require(number is Number && number.toDouble() % 1.0 == 0.0 && number.toDouble() in 35.0..120.0)
        return number.toFloat() / 100f
    }
    return PersonaPlacement(scale("speaking"), scale("listening"), scale("idle"))
}

internal fun decodePreviewOffset(value: Any): Int {
    require(value is Number && value.toDouble() % 1.0 == 0.0 && value.toDouble() in -200.0..200.0)
    return value.toInt()
}

internal fun decodePreviewPlacement(data: JSONObject): PersonaPlacement =
    decodePreviewScales(data.getJSONObject("scales")).copy(offsetY = decodePreviewOffset(data.get("verticalOffsetDp")).dp)

internal data class PersonaPreviewState(
    val placement: PersonaPlacement = defaultPortraitLayout().placement,
    val saved: PersonaPlacement = placement,
    val mode: String = "speaking",
    val connection: String = "connected",
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
    val sharedAppearance: PreviewSharedAppearance = PreviewSharedAppearance.from(
        if (orientation == "portrait") PreviewLayout(placement, design, halo, spirit, personaSide) else otherLayout),
    val savedSharedAppearance: PreviewSharedAppearance = sharedAppearance,
    val showPushToTalk: Boolean = true,
    val icons: PreviewIcons = PreviewIcons(),
    val sounds: PreviewSounds = PreviewSounds(),
    val savedSounds: PreviewSounds = sounds,
) {
    init { require(theme in previewThemes && mutedPresence in previewMutedPresences && presenceScope in previewPresenceScopes)
        require(horizontalOffsetDp in -200..200 && savedHorizontalOffsetDp in -200..200)
        require(appearanceOverrides.all { it in previewAppearanceGroups } && savedAppearanceOverrides.all { it in previewAppearanceGroups }) }
    fun activeLayout() = PreviewLayout(placement, design, halo, spirit, personaSide, horizontalOffsetDp, appearanceOverrides)
    fun savedLayout() = PreviewLayout(saved, savedDesign, savedHalo, savedSpirit, savedPersonaSide, savedHorizontalOffsetDp, savedAppearanceOverrides)
    fun rotate(next: String): PersonaPreviewState {
        require(next in previewOrientations)
        if (next == orientation) return this
        val released = endHold()
        return released.copy(orientation = next, orientationEpoch = orientationEpoch + 1,
            placement = otherLayout.placement, design = otherLayout.design, halo = otherLayout.halo,
            spirit = otherLayout.spirit, personaSide = otherLayout.personaSide,
            horizontalOffsetDp = otherLayout.horizontalOffsetDp, appearanceOverrides = otherLayout.appearanceOverrides,
            saved = savedOtherLayout.placement, savedDesign = savedOtherLayout.design, savedHalo = savedOtherLayout.halo,
            savedSpirit = savedOtherLayout.spirit, savedPersonaSide = savedOtherLayout.personaSide,
            savedHorizontalOffsetDp = savedOtherLayout.horizontalOffsetDp, savedAppearanceOverrides = savedOtherLayout.appearanceOverrides,
            otherLayout = activeLayout(), savedOtherLayout = savedLayout(), revision = released.revision + 1)
    }
    fun withSavedLayouts(portrait: PreviewLayout, landscape: PreviewLayout, shared: PreviewSharedAppearance = sharedAppearance): PersonaPreviewState {
        val effectivePortrait = shared.applyTo(portrait)
        val effectiveLandscape = shared.applyTo(landscape).let { it.copy(design = it.design.copy(spacing = portrait.design.spacing)) }
        val active = if (orientation == "portrait") effectivePortrait else effectiveLandscape
        return copy(saved = active.placement, savedDesign = active.design, savedHalo = active.halo,
            savedSpirit = active.spirit, savedPersonaSide = active.personaSide,
            savedHorizontalOffsetDp = active.horizontalOffsetDp, savedAppearanceOverrides = active.appearanceOverrides, savedSharedAppearance = shared,
            savedOtherLayout = if (orientation == "portrait") effectiveLandscape else effectivePortrait)
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
        return withEffectiveLayout(shared.applyTo(snapshot)).copy(sharedAppearance = shared,
            otherLayout = shared.applyTo(otherLayout).let { it.copy(design = it.design.copy(spacing = requested.design.spacing)) })
    }

    fun json(): JSONObject = JSONObject().put("protocol", 21).put("showPushToTalk", showPushToTalk).put("icons", icons.json())
        .put("sounds", sounds.json()).put("savedSounds", savedSounds.json()).put("defaultSounds", PreviewSounds().json())
        .put("horizontalOffsetDp", horizontalOffsetDp).put("savedHorizontalOffsetDp", savedHorizontalOffsetDp).put("defaultHorizontalOffsetDp", 0)
        .put("appearanceOverrides", appearanceOverrides.appearanceJson()).put("savedAppearanceOverrides", savedAppearanceOverrides.appearanceJson())
        .put("sharedAppearance", sharedAppearance.json()).put("savedSharedAppearance", savedSharedAppearance.json())
        .put("defaultSharedAppearance", PreviewSharedAppearance.from(defaultPortraitLayout()).json())
        .put("theme", theme).put("mutedPresence", mutedPresence).put("mutedTuning", mutedTuning.json()).put("presenceScope", presenceScope)
        .put("orientation", orientation).put("orientationEpoch", orientationEpoch)
        .put("personaSide", personaSide).put("savedPersonaSide", savedPersonaSide).put("defaultPersonaSide", "left")
        .put("otherLayout", otherLayout.json()).put("savedOtherLayout", savedOtherLayout.json()).put("connection", connection).put("revision", revision)
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
            mode = if (micMuted) "listening" else if (mode == "speaking") "speaking" else "idle", revision = revision + 1)
        "speaker" -> copy(speakerMuted = !speakerMuted, holding = false,
            mode = if (speakerMuted) "speaking" else if (!micMuted) "listening" else "idle", revision = revision + 1)
        else -> error("Unknown channel")
    }

    fun beginHold() = if (connection == "connected" && micMuted && showPushToTalk) copy(mode = "listening", holding = true, revision = revision + 1) else this
    fun endHold() = if (holding) copy(mode = "idle", micMuted = true, holding = false, revision = revision + 1) else this

    fun ui(): CallUi {
        val connected = connection == "connected"
        return CallUi(running = connection != "disconnected", connected = connected,
            phase = when (connection) { "connecting" -> "Connecting"; "disconnected" -> "Disconnected"; else -> "Connected" },
            micMuted = micMuted, micOpen = connected && (!micMuted || holding), speakerMuted = speakerMuted,
            speakerOpen = connected && !speakerMuted, canHold = connected && micMuted && showPushToTalk, holding = connected && holding,
            outputLevel = if (connected && mode == "speaking" && !speakerMuted) .14f else 0f)
    }
}

internal fun restorePersonaPreview(data: JSONObject, saved: PersonaPlacement, savedDesign: PreviewDesign = PreviewDesign(), savedHalo: PreviewHalo = PreviewHalo(), savedSpirit: PreviewSpirit = PreviewSpirit(), savedLandscape: PreviewLayout = PreviewLayout(), savedPortraitSide: String = "left", savedHorizontalOffsetDp: Int = 0, savedOverrides: Set<String> = emptySet(),
    savedShared: PreviewSharedAppearance = PreviewSharedAppearance.from(PreviewLayout(saved, savedDesign, savedHalo, savedSpirit, savedPortraitSide)),
    savedSounds: PreviewSounds = PreviewSounds()): PersonaPreviewState {
    val mode = data.getString("mode")
    val revision = data.get("revision")
    require(mode in previewModes && revision is Int && revision >= 0)
    val holding = data.getBoolean("holding")
    val connection = data.optString("connection", "connected")
    require(connection in previewConnections)
    val activity = data.optString("activity", "steady")
    require(activity in previewActivities)
    val orientation = data.optString("orientation", "portrait").also { require(it in previewOrientations) }
    val epoch = data.optInt("orientationEpoch", 0).also { require(it >= 0) }
    val protocol = data.optInt("protocol", 10)
    require(protocol in 1..21)
    if (protocol >= 18) {
        decodePreviewSounds(data.getJSONObject("savedSounds"))
        require(decodePreviewSounds(data.getJSONObject("defaultSounds")) == PreviewSounds())
    }
    val restored = PersonaPreviewState(placement = decodePreviewPlacement(data), saved = saved,
        mode = if (holding) "idle" else mode, connection = connection, revision = revision, activity = activity,
        design = data.optJSONObject("design")?.let {
            if (protocol in 3..11) decodePersonaDesign(JSONObject().put("version", protocol).put("design", it).toString())
            else {
                val spaced = if (protocol <= 13) withVersionTwelvePadding(it) else it
                val migrated = if (protocol <= 15) withLegacyTraceJoin(spaced) else if (protocol <= 18) withoutLegacyOffshoots(spaced) else spaced
                if (protocol <= 19) decodeLegacyControlExtentDesign(migrated) else decodePreviewDesign(migrated)
            }
        } ?: PreviewDesign(), savedDesign = savedDesign,
        halo = data.optJSONObject("halo")?.let(::decodePreviewHalo) ?: PreviewHalo(), savedHalo = savedHalo,
        spirit = data.optJSONObject("spirit")?.let(::decodePreviewSpirit) ?: PreviewSpirit(), savedSpirit = savedSpirit,
        micMuted = holding || data.optBoolean("micMuted", mode != "listening"), speakerMuted = data.optBoolean("speakerMuted", false),
        orientation = orientation, orientationEpoch = epoch,
        personaSide = data.optString("personaSide", "left").also { require(it in previewPersonaSides) },
        otherLayout = data.optJSONObject("otherLayout")?.let { decodePreviewLayout(it, if (protocol >= 20) 18 else if (protocol >= 19) 17 else if (protocol >= 17) 16 else if (protocol >= 16) 14 else if (protocol >= 14) 13 else if (protocol == 13) 12 else protocol) } ?: PreviewLayout(),
        theme = data.optString("theme", "bright"), mutedPresence = data.optString("mutedPresence", "tide"),
        mutedTuning = if (protocol >= 13) decodePreviewMutedTuning(data.getJSONObject("mutedTuning")) else PreviewMutedTuning(),
        presenceScope = if (protocol >= 15) data.getString("presenceScope") else "any-muted",
        horizontalOffsetDp = if (protocol >= 17) decodePreviewOffset(data.get("horizontalOffsetDp")) else 0,
        appearanceOverrides = if (protocol >= 17) decodeAppearanceOverrides(data.getJSONArray("appearanceOverrides")) else emptySet(),
        icons = if (protocol >= 21) decodePreviewIcons(data.getJSONObject("icons")) else PreviewIcons(),
        showPushToTalk = if (protocol >= 19) decodePreviewBoolean(data.get("showPushToTalk")) else true,
        sounds = if (protocol >= 18) decodePreviewSounds(data.getJSONObject("sounds")) else PreviewSounds(),
        savedSounds = savedSounds)
    val portrait = if (orientation == "portrait") restored.activeLayout() else restored.otherLayout
    val landscape = if (orientation == "landscape") restored.activeLayout() else restored.otherLayout
    val shared = if (protocol >= 17) decodeSharedAppearance(data.getJSONObject("sharedAppearance"), legacyOffshoots = protocol <= 18) else PreviewSharedAppearance.from(portrait)
    val scopedLandscape = if (protocol >= 17) landscape else landscape.copy(appearanceOverrides = legacyLandscapeOverrides(landscape, shared))
    if (protocol >= 19) require(portrait.design.spacing == landscape.design.spacing)
    val migratedLandscape = if (protocol >= 19) scopedLandscape else scopedLandscape.copy(design = scopedLandscape.design.copy(spacing = portrait.design.spacing))
    val active = shared.applyTo(if (orientation == "portrait") portrait else migratedLandscape)
    val other = shared.applyTo(if (orientation == "portrait") migratedLandscape else portrait)
    if (protocol >= 17) {
        fun expected(layout: PreviewLayout) = if (protocol >= 19) layout else layout.copy(design = layout.design.copy(spacing = portrait.design.spacing))
        require(active == expected(restored.activeLayout()) && other == expected(restored.otherLayout))
    }
    return restored.withEffectiveLayout(active).copy(sharedAppearance = shared, otherLayout = other)
        .withSavedLayouts(PreviewLayout(saved, savedDesign, savedHalo, savedSpirit, savedPortraitSide, savedHorizontalOffsetDp, savedOverrides), savedLandscape, savedShared)
}

internal class PersonaPreviewSession(initial: PersonaPlacement, private val selection: File, initialDesign: PreviewDesign = defaultPortraitLayout().design, initialHalo: PreviewHalo = defaultPortraitLayout().halo, initialSpirit: PreviewSpirit = defaultPortraitLayout().spirit, initialLandscape: PreviewLayout = defaultLandscapeLayout(), initialPortraitSide: String = "left", initialHorizontalOffsetDp: Int = 0,
    initialOverrides: Set<String> = emptySet(), initialShared: PreviewSharedAppearance? = null,
    initialSounds: PreviewSounds = PreviewSounds()) {
    private val shared = initialShared ?: PreviewSharedAppearance.from(PreviewLayout(initial, initialDesign, initialHalo, initialSpirit))
    private val spacedLandscape = initialLandscape.copy(design = initialLandscape.design.copy(spacing = initialDesign.spacing))
    private val landscape = shared.applyTo(if (initialShared == null) spacedLandscape.copy(
        appearanceOverrides = spacedLandscape.appearanceOverrides + legacyLandscapeOverrides(spacedLandscape, shared)) else spacedLandscape)
    var state by mutableStateOf(PersonaPreviewState(placement = initial, design = initialDesign, halo = initialHalo,
        spirit = initialSpirit, otherLayout = landscape, personaSide = initialPortraitSide,
        horizontalOffsetDp = initialHorizontalOffsetDp, appearanceOverrides = initialOverrides, sharedAppearance = shared,
        sounds = initialSounds))

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
            val portrait = if (selected.orientation == "portrait") selected.activeLayout() else selected.otherLayout
            val landscape = if (selected.orientation == "landscape") selected.activeLayout() else selected.otherLayout
            profile = encodePersonaTuning(portrait.placement, portrait.design, portrait.halo, portrait.spirit, landscape, portrait.personaSide, portrait.horizontalOffsetDp, portrait.appearanceOverrides, selected.sharedAppearance, selected.sounds)
            savePersonaTuning(selection, profile)
            withContext(Dispatchers.Main) { state = state.withSavedLayouts(portrait, landscape, selected.sharedAppearance).copy(savedSounds = selected.sounds) }
        }
        return withContext(Dispatchers.Main) {
            when (method) {
                "get" -> require(request.fields() == setOf("id", "method"))
                "preview" -> {
                    require(request.fields() == setOf("id", "method", "connection", "mode", "scales", "verticalOffsetDp", "design", "halo", "spirit", "activity", "orientation", "orientationEpoch", "personaSide", "theme", "mutedPresence", "mutedTuning", "presenceScope", "horizontalOffsetDp", "appearanceOverrides", "sounds", "showPushToTalk", "icons"))
                    checkOrientation(request)
                    val side = request.getString("personaSide").also { require(it in previewPersonaSides) }
                    val mode = request.getString("mode")
                    require(mode in previewModes)
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
                    val showPushToTalk = decodePreviewBoolean(request.get("showPushToTalk"))
                    val sounds = decodePreviewSounds(request.getJSONObject("sounds"))
                    val icons = decodePreviewIcons(request.getJSONObject("icons"))
                    val next = if (mode != state.mode) state.select(mode) else state.endHold()
                    state = next.applyAppearance(PreviewLayout(placement, design, halo, spirit, side, horizontal, overrides)).copy(
                        activity = activity, connection = connection, theme = theme, mutedPresence = mutedPresence,
                        mutedTuning = mutedTuning, presenceScope = presenceScope, sounds = sounds, showPushToTalk = showPushToTalk, icons = icons, revision = state.revision + 1)
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
