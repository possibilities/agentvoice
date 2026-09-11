package com.arthack.agentvoice

import androidx.compose.foundation.background
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.unit.Dp
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
    presenceScope: String = "any-muted",
    horizontalOffsetDp: Int = 0,
    onReleaseCompleted: () -> Unit = onRelease,
    showPushToTalk: Boolean = true,
    icons: PreviewIcons = PreviewIcons(),
    handleBack: Boolean = true,
    connectionStyle: String = "relay",
    connectionDetail: String? = null,
    onConnect: (() -> Unit)? = null,
    onCancelConnection: (() -> Unit)? = null,
    onNavigationHint: (() -> Unit)? = null,
) {
    CompositionLocalProvider(LocalPreviewTheme provides PreviewTheme.resolve(theme), LocalPreviewIcons provides icons) {
        PreviewStudioScene(ui, design, placement, onMute, onHold, onRelease, onExit,
            connection, halo, spirit, activity, personaSide, mutedPresence, mutedTuning, presenceScope, horizontalOffsetDp, onReleaseCompleted, showPushToTalk, handleBack, connectionStyle, connectionDetail, onConnect, onCancelConnection, onNavigationHint)
    }
}

@Composable
private fun PreviewStudioScene(
    ui: CallUi, design: PreviewDesign, placement: PersonaPlacement,
    onMute: (String) -> Unit, onHold: () -> Unit, onRelease: () -> Unit, onExit: () -> Unit,
    connection: String, halo: PreviewHalo, spirit: PreviewSpirit, activity: String,
    personaSide: String, mutedPresence: String, mutedTuning: PreviewMutedTuning, presenceScope: String, horizontalOffsetDp: Int, onReleaseCompleted: () -> Unit, showPushToTalk: Boolean, handleBack: Boolean,
    connectionStyle: String, connectionDetail: String?, onConnect: (() -> Unit)?, onCancelConnection: (() -> Unit)?,
    onNavigationHint: (() -> Unit)?,
) {
    val theme = LocalPreviewTheme.current
    androidx.activity.compose.BackHandler(enabled = handleBack, onBack = onExit)
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
    val muted = previewCenterIndicatorEligible(ui, mutedPresence, presenceScope, foreground)
    val scene = rememberPreviewSpirit(ui, spirit, halo, activity, motionAllowed = motionAllowed,
        ambientPercent = design.traces.glowPercent, foreground = foreground, mutedPresence = muted,
        mutedCycleSeconds = mutedTuning.cycleSeconds)
    val controlsExtent = design.controlsExtent(showPushToTalk)
    val deck = PreviewControlGeometry(controlsExtent, design.holdSharePercent, design.spacing.effectivePushGapDp, showPushToTalk)
    BoxWithConstraints(Modifier.fillMaxSize().background(theme.palette.ground)) {
        val screenWidth = maxWidth
        val portrait = maxHeight >= maxWidth
        PreviewAmbientGlow(scene.ambient, Modifier.matchParentSize())
        val density = LocalDensity.current
        val cutouts = WindowInsets.displayCutout
        val safe = WindowInsets.safeDrawing
        val cutoutPadding = with(density) {
            PreviewCutoutPadding(
                minOf(cutouts.getLeft(this, androidx.compose.ui.unit.LayoutDirection.Ltr), safe.getLeft(this, androidx.compose.ui.unit.LayoutDirection.Ltr)).toDp().value,
                minOf(cutouts.getTop(this), safe.getTop(this)).toDp().value,
                minOf(cutouts.getRight(this, androidx.compose.ui.unit.LayoutDirection.Ltr), safe.getRight(this, androidx.compose.ui.unit.LayoutDirection.Ltr)).toDp().value,
                minOf(cutouts.getBottom(this), safe.getBottom(this)).toDp().value,
            )
        }
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
            val viewportWidth = maxWidth.value
            val viewportHeight = maxHeight.value
            val target = previewOrientationGeometry(maxWidth.value, maxHeight.value, screenWidth.value,
                portrait, controlsExtent.toFloat(), if (portrait) placement.offsetY.value else 0f, personaSide,
                spacing = design.spacing, actualDeckHeight = if (portrait) deck.extentHeightDp else controlsExtent.toFloat(), horizontalOffsetDp = horizontalOffsetDp.toFloat(), cutoutPadding = cutoutPadding)
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
            val clearRadius = rememberTraceRadius(geometry.diameter, halo, placement).dp
            val displayedPlacement = remember(halo.variant) {
                if (halo.variant == "original") PersonaDisplayedPlacement() else null
            }
            val displayedClearRadius: (() -> Dp)? = if (halo.variant == "original") ({
                // This is the exact scale used by PersonaHalo's graphics layer, including
                // native-governed listening handover. Keep the existing .4 guard factor.
                displayedPlacement?.scale?.let { (geometry.diameter * it * .4f).dp } ?: clearRadius
            }) else null
            val traceAlpha = when {
                destination.layoutKey != target.layoutKey -> 0f
                changing -> (progress.value * 2f - 1f).coerceAtLeast(0f)
                else -> 1f
            }
            Box(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxWidth().height(geometry.contentHeight.dp)) {
                    val traceLayer = Modifier.matchParentSize().graphicsLayer { alpha = traceAlpha }
                    if (portrait) {
                        PreviewPersonaTraces(geometry.deckY.dp, deck.extentHeightDp.dp, geometry.deckX.dp,
                            traceLayer, (geometry.stageY + geometry.diameter / 2f + geometry.offsetY).dp,
                            clearRadius, design.traces, design.spacing.effectiveChannelGapDp, displayedClearRadius)
                    } else {
                        PreviewLandscapeTraces(geometry, clearRadius, design, traceLayer, displayedClearRadius)
                    }
                    Box(Modifier.offset { IntOffset(geometry.stageX.dp.roundToPx(), geometry.stageY.dp.roundToPx()) }
                        .requiredSize(geometry.diameter.dp)) {
                        val stage = Modifier.fillMaxSize().testTag("studio-persona-stage")
                        key(halo.variant) {
                            val presentedPlacement = placement.copy(offsetY = geometry.offsetY.dp)
                            if (halo.variant == "contained") PreviewSpiritHalo(ui, stage, presentedPlacement, halo, scene.colors)
                            else PersonaHalo(ui, stage, presentedPlacement, PersonaColors(
                                listening = theme.haloArgb(VoiceInk.you.toArgb()), speaking = theme.haloArgb(VoiceInk.agent.toArgb()),
                                idle = theme.haloArgb(VoiceInk.text.toArgb()), asleep = theme.haloArgb(VoiceInk.muted.toArgb())), displayedPlacement)
                        }
                        // Only disconnected/connecting Idle uses this aperture. Connected speech and
                        // listening remove the notice immediately, without a stale outgoing status.
                        val noticeScale = if (halo.variant == "contained") halo.containedSizePercent / 100f else placement.idleScale
                        val idleInset = if (halo.variant == "contained") .20f * (1f - .06f * halo.idleBreathingPercent / 100f) else .16f
                        PreviewConnectionNotice(connection,
                            Modifier.align(Alignment.Center).offset(y = geometry.offsetY.dp),
                            style = connectionStyle, innerRadius = (geometry.diameter * 1.9f * noticeScale * idleInset).dp,
                            detail = connectionDetail, onConnect = onConnect, onCancel = onCancelConnection)
                        val aperture = rememberMutedAperture(geometry.diameter, halo, placement, motionAllowed && foreground)
                        if (mutedPresence == "tide") {
                            PreviewMutedPresence(muted, motionAllowed, scene.phaseTurns, geometry.diameter.dp,
                                geometry.offsetY.dp, aperture.dp,
                                ink = theme.foreground(VoiceInk.muted, theme.palette.ground, opacity = .84f),
                                primaryInk = theme.foreground(VoiceInk.text, theme.palette.ground), tuning = mutedTuning)
                        } else {
                            PreviewCenterIndicator(ui, mutedPresence, presenceScope, foreground, motionAllowed,
                                scene.phaseTurns, geometry.diameter.dp, geometry.offsetY.dp, aperture.dp, mutedTuning)
                        }
                    }
                    if (ui.connected && onNavigationHint != null && !changing) {
                        val bounds = personaHintBounds(geometry, viewportWidth, viewportHeight)
                        val hint by rememberUpdatedState(onNavigationHint)
                        Box(Modifier.offset { IntOffset(bounds.x.dp.roundToPx(), bounds.y.dp.roundToPx()) }
                            .size(bounds.width.dp, bounds.height.dp)
                            .testTag("persona-navigation-hint")
                            .semantics { onLongClick("Show navigation hint") { hint(); true } }
                            .pointerInput(target.layoutKey) { detectTapGestures(onLongPress = { hint() }) })
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
                        .then(if (changing) Modifier.clearAndSetSemantics { disabled() } else Modifier)) {
                        // A relocated target cannot inherit the finger that owned its previous position.
                        key(target.layoutKey) {
                            PreviewControls(ui, { if (!latestChanging) onMute(it) }, { if (!latestChanging) onHold() }, release,
                                Modifier.fillMaxWidth(), controlsHeightDp = controlsExtent,
                                holdSharePercent = design.holdSharePercent, light = scene.light, spacing = design.spacing,
                                availableHeightDp = geometry.deckViewportHeight,
                                onReleaseCompleted = { if (!latestChanging) onReleaseCompleted() else release() }, showPushToTalk = showPushToTalk, landscape = !portrait, mirror = personaSide == "right")
                        }
                    }
                }
            }

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


@Composable
private fun rememberTraceRadius(diameter: Float, halo: PreviewHalo, placement: PersonaPlacement): Float {
    val size = halo.containedSizePercent / 100f
    var retainedSize by remember { mutableFloatStateOf(size) }
    SideEffect {
        retainedSize = maxOf(retainedSize, size)
    }
    LaunchedEffect(size) {
        // Source debounce also applies to reduced motion; never expose its older larger pose.
        kotlinx.coroutines.delay(600)
        retainedSize = size
    }
    if (halo.variant != "contained") return diameter * 1.9f *
        maxOf(placement.speakingScale, placement.listeningScale, placement.idleScale) * .4f
    // Tuck feeds into the nominal frame's peripheral band instead of reserving the largest
    // speaking pose. The trace-only fade preserves a clear core; native Halo paints above it.
    return diameter * 1.9f * maxOf(retainedSize, size) * .23f
}
