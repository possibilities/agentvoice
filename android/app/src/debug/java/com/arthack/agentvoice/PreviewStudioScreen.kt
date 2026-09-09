package com.arthack.agentvoice

import androidx.compose.foundation.background
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntOffset
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** Experimental layouts keep the native Halo and the controls in separate, stable layers. */
@Composable
internal fun PreviewStudioScreen(
    ui: CallUi,
    design: PreviewDesign,
    placement: PersonaPlacement,
    onMute: (String) -> Unit,
    onHold: () -> Unit,
    onRelease: () -> Unit,
    onExit: () -> Unit,
    connection: String = "connected",
    halo: PreviewHalo = PreviewHalo(),
    spirit: PreviewSpirit = PreviewSpirit(),
    activity: String = "steady",
    personaSide: String = "left",
    theme: String = "bright",
    mutedPresence: String = "tide",
    mutedTuning: PreviewMutedTuning = PreviewMutedTuning(),
) {
    CompositionLocalProvider(LocalPreviewTheme provides PreviewTheme.resolve(theme)) {
        PreviewStudioScene(ui, design, placement, onMute, onHold, onRelease, onExit,
            connection, halo, spirit, activity, personaSide, mutedPresence, mutedTuning)
    }
}

@Composable
private fun PreviewStudioScene(
    ui: CallUi, design: PreviewDesign, placement: PersonaPlacement,
    onMute: (String) -> Unit, onHold: () -> Unit, onRelease: () -> Unit, onExit: () -> Unit,
    connection: String, halo: PreviewHalo, spirit: PreviewSpirit, activity: String,
    personaSide: String, mutedPresence: String, mutedTuning: PreviewMutedTuning,
) {
    val theme = LocalPreviewTheme.current
    androidx.activity.compose.BackHandler(onBack = onExit)
    val currentRelease by rememberUpdatedState(onRelease)
    DisposableEffect(Unit) { onDispose { currentRelease() } }
    val motionAllowed = previewSpiritMotionAllowed()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val muted = mutedPresence == "tide" && previewMutedEligible(ui, foreground)
    val scene = rememberPreviewSpirit(ui, spirit, halo, activity, motionAllowed = motionAllowed,
        ambientPercent = design.traces.glowPercent, foreground = foreground, mutedPresence = muted,
        mutedCycleSeconds = mutedTuning.cycleSeconds)
    val deck = PreviewControlGeometry(design.controlsHeightDp, design.holdSharePercent, design.spacing.pushGapDp)
    BoxWithConstraints(Modifier.fillMaxSize().background(theme.palette.ground)) {
        val screenWidth = maxWidth
        val portrait = maxHeight >= maxWidth
        PreviewAmbientGlow(scene.ambient, Modifier.matchParentSize())
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
            val target = previewOrientationGeometry(maxWidth.value, maxHeight.value, screenWidth.value,
                portrait, design.controlsHeightDp.toFloat(), placement.offsetY.value, personaSide,
                spacing = design.spacing, actualDeckHeight = deck.extentHeightDp)
            var source by remember { mutableStateOf(target) }
            var destination by remember { mutableStateOf(target) }
            val progress = remember { Animatable(1f) }
            val changing = destination.layoutKey != target.layoutKey || progress.value < 1f
            val latestChanging by rememberUpdatedState(changing)
            val latestLayout by rememberUpdatedState(target.layoutKey)
            var releasedLayout by remember { mutableStateOf<String?>(null) }
            val release = remember {
                {
                    // Disposal and relocation share one release even before the parent recomposes.
                    if (!latestChanging || releasedLayout != latestLayout) {
                        if (latestChanging) releasedLayout = latestLayout
                        currentRelease()
                    }
                }
            }
            LaunchedEffect(target, motionAllowed, foreground, ui.connected) {
                val relocated = destination.layoutKey != target.layoutKey
                val continueMotion = progress.value < 1f
                if (relocated) release()
                if ((relocated || continueMotion) && motionAllowed && foreground && ui.connected) {
                    source = source.towards(destination, progress.value)
                    destination = target
                    progress.snapTo(0f)
                    progress.animateTo(1f, tween(320, easing = FastOutSlowInEasing))
                } else {
                    source = target
                    destination = target
                    progress.snapTo(1f)
                }
            }
            // Ordinary tuning updates keep the existing immediate geometry behavior.
            val geometry = if (changing) source.towards(destination, progress.value) else target
            val sceneScroll = rememberScrollState()
            val deckScroll = rememberScrollState()
            LaunchedEffect(target.layoutKey) { sceneScroll.scrollTo(0); deckScroll.scrollTo(0) }
            // The underlay's aperture follows selected geometry, never an animated frame or state.
            val maximumScale = if (halo.variant == "contained") halo.containedSizePercent / 100f
                else maxOf(placement.speakingScale, placement.listeningScale, placement.idleScale)
            val clearRadius = geometry.diameter.dp * maximumScale * 1.9f * if (halo.variant == "contained") .27f else .4f
            val traceAlpha = when {
                destination.layoutKey != target.layoutKey -> 0f
                changing -> (progress.value * 2f - 1f).coerceAtLeast(0f)
                else -> 1f
            }
            Box(Modifier.fillMaxSize().verticalScroll(sceneScroll,
                enabled = portrait && target.contentHeight > maxHeight.value)) {
                Box(Modifier.fillMaxWidth().height(geometry.contentHeight.dp)) {
                    val traceLayer = Modifier.matchParentSize().graphicsLayer { alpha = traceAlpha }
                    if (portrait) {
                        PreviewPersonaTraces(geometry.deckY.dp, deck.extentHeightDp.dp, geometry.deckX.dp,
                            traceLayer, (geometry.stageY + geometry.diameter / 2f + geometry.offsetY).dp,
                            clearRadius, design.traces, design.spacing.channelGapDp)
                    } else {
                        PreviewLandscapeTraces(geometry, clearRadius, design, deckScroll.value, traceLayer)
                    }
                    Box(Modifier.offset { IntOffset(geometry.stageX.dp.roundToPx(), geometry.stageY.dp.roundToPx()) }
                        .requiredSize(geometry.diameter.dp)) {
                        val stage = Modifier.fillMaxSize().testTag("studio-persona-stage")
                        key(halo.variant) {
                            val presentedPlacement = placement.copy(offsetY = geometry.offsetY.dp)
                            if (halo.variant == "contained") PreviewSpiritHalo(ui, stage, presentedPlacement, halo, scene.colors)
                            else PersonaHalo(ui, stage, presentedPlacement, PersonaColors(
                                listening = theme.haloArgb(VoiceInk.you.toArgb()), speaking = theme.haloArgb(VoiceInk.agent.toArgb()),
                                idle = theme.haloArgb(VoiceInk.text.toArgb()), asleep = theme.haloArgb(VoiceInk.muted.toArgb())))
                        }
                        val aperture = rememberMutedAperture(geometry.diameter, halo, placement, motionAllowed && foreground)
                        PreviewMutedPresence(muted, motionAllowed, scene.phaseTurns, geometry.diameter.dp,
                            geometry.offsetY.dp, aperture.dp,
                            ink = theme.foreground(VoiceInk.muted, theme.palette.ground, opacity = .84f),
                            primaryInk = theme.foreground(VoiceInk.text, theme.palette.ground), tuning = mutedTuning)
                    }
                    Box(Modifier.offset { IntOffset(geometry.deckX.dp.roundToPx(), geometry.deckY.dp.roundToPx()) }
                        .requiredSize(geometry.deckWidth.dp, geometry.deckViewportHeight.dp)
                        .pointerInput(Unit) {
                            awaitEachGesture {
                                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                if (latestChanging) {
                                    down.consume()
                                    do {
                                        val event = awaitPointerEvent(PointerEventPass.Initial)
                                        event.changes.forEach { it.consume() }
                                    } while (event.changes.any { it.pressed })
                                }
                            }
                        }
                        .then(if (changing) Modifier.clearAndSetSemantics { disabled() } else Modifier)
                        .verticalScroll(deckScroll, enabled = !portrait && target.deckViewportHeight < deck.extentHeightDp)) {
                        // A relocated target cannot inherit the finger that owned its previous position.
                        key(target.layoutKey) {
                            PreviewControls(ui, { if (!latestChanging) onMute(it) }, { if (!latestChanging) onHold() }, release,
                                Modifier.fillMaxWidth(), controlsHeightDp = design.controlsHeightDp,
                                holdSharePercent = design.holdSharePercent, light = scene.light, spacing = design.spacing)
                        }
                    }
                }
            }
            PreviewConnectionNotice(connection, Modifier.align(Alignment.TopCenter).fillMaxWidth())
        }
    }
}

@Composable
private fun PreviewSpiritHalo(ui: CallUi, modifier: Modifier, placement: PersonaPlacement, halo: PreviewHalo,
    colors: State<CompactHaloColors>) {
    val theme = LocalPreviewTheme.current
    val base = colors.value
    val themed = if (theme == PreviewTheme.Bright) base else CompactHaloColors(
        theme.haloArgb(base.speaking), theme.haloArgb(base.listening), theme.haloArgb(base.idle),
        theme.haloArgb(base.asleep))
    CompactPersonaHalo(ui, modifier, halo.placement(placement), halo.tuning(), themed)
}

internal fun previewMutedEligible(ui: CallUi, foreground: Boolean): Boolean =
    foreground && ui.connected && !ui.controlsPending && !ui.micOpen && !ui.speakerOpen

/** Conservative inner apertures include the smallest transition pose, not the trace attachment radius. */
@Composable
private fun rememberMutedAperture(diameter: Float, halo: PreviewHalo, placement: PersonaPlacement,
    animate: Boolean): Float {
    val scale = if (halo.variant == "contained") halo.containedSizePercent / 100f
        else minOf(placement.speakingScale, placement.listeningScale, placement.idleScale)
    val factor = previewMutedApertureFactor(halo)
    var retainedScale by remember { mutableFloatStateOf(scale) }
    var retainedFactor by remember { mutableFloatStateOf(factor) }
    SideEffect {
        retainedScale = minOf(retainedScale, scale)
        retainedFactor = minOf(retainedFactor, factor)
    }
    LaunchedEffect(scale, factor, animate) {
        // Independent minima cover crossed size/tuning edits and the old source's debounce window.
        if (animate) kotlinx.coroutines.delay(600)
        retainedScale = scale
        retainedFactor = factor
    }
    return diameter * 1.9f * minOf(retainedScale, scale) * minOf(retainedFactor, factor)
}
