package com.arthack.agentvoice

import android.view.accessibility.AccessibilityManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay

/** Debug-only chrome; every displayed channel state belongs to the synthetic preview. */
@Composable
internal fun PreviewHeader(
    choice: String,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    ui: CallUi,
    onExit: () -> Unit,
    modifier: Modifier = Modifier,
    interactionActive: Boolean = false,
    onReservedHeightChange: (Dp) -> Unit = {},
) {
    require(choice in setOf("quiet", "drawer", "none"))
    val density = LocalDensity.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val accessibility = LocalContext.current.getSystemService(AccessibilityManager::class.java)
    val accessibilityTimeouts = LocalAccessibilityManager.current
    val currentExpandedChange by rememberUpdatedState(onExpandedChange)
    val currentReservationChange by rememberUpdatedState(onReservedHeightChange)
    var railHeight by remember(choice, density) { mutableIntStateOf(0) }
    var detailsHeight by remember(choice, density) { mutableStateOf<Int?>(null) }
    var keepOpen by rememberSaveable(choice) { mutableStateOf(false) }
    var touching by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    var interactionRevision by remember { mutableIntStateOf(0) }
    var assistiveTechnology by remember(accessibility) { mutableStateOf(accessibility?.isEnabled == true) }
    var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    val hoverSource = remember { MutableInteractionSource() }
    val hovered by hoverSource.collectIsHoveredAsState()
    val disclosure = remember { MutableTransitionState(expanded) }
    disclosure.targetState = expanded

    DisposableEffect(lifecycle, accessibility) {
        val observer = LifecycleEventObserver { _, _ ->
            resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
        val accessibilityListener = AccessibilityManager.AccessibilityStateChangeListener { enabled ->
            assistiveTechnology = enabled
        }
        lifecycle.addObserver(observer)
        accessibility?.addAccessibilityStateChangeListener(accessibilityListener)
        onDispose {
            lifecycle.removeObserver(observer)
            accessibility?.removeAccessibilityStateChangeListener(accessibilityListener)
        }
    }

    // Report the content's target size, not AnimatedVisibility's intermediate heights.
    // The parent can animate the Halo once without resizing it or moving its controls.
    LaunchedEffect(choice, expanded, railHeight, detailsHeight, density) {
        if (choice == "none" && !expanded) {
            currentReservationChange(0.dp)
        } else if (railHeight > 0 && (!expanded || detailsHeight != null)) {
            val height = railHeight + if (expanded) detailsHeight!! else 0
            currentReservationChange(with(density) { height.toDp() })
        }
    }

    val safeToHide = choice == "drawer" && expanded && !keepOpen && resumed &&
        !interactionActive && !touching && !hovered && !focused && !assistiveTechnology &&
        !ui.holding && !ui.controlsPending && ui.connected && ui.message.isNullOrEmpty()
    val currentSafeToHide by rememberUpdatedState(safeToHide)
    LaunchedEffect(safeToHide, interactionRevision, accessibilityTimeouts) {
        if (safeToHide) {
            val timeout = accessibilityTimeouts?.calculateRecommendedTimeoutMillis(
                originalTimeoutMillis = 8_000L, containsIcons = true, containsText = true, containsControls = true,
            ) ?: 8_000L
            if (timeout != Long.MAX_VALUE) {
                delay(timeout)
                // A pointer or focus event can precede the recomposition that cancels this timer.
                if (currentSafeToHide && !touching && !focused && !hovered && resumed && !assistiveTechnology && !keepOpen) {
                    currentExpandedChange(false)
                }
            }
        }
    }
    BackHandler(enabled = expanded) { currentExpandedChange(false) }

    val reveal: () -> Unit = {
        interactionRevision++
        currentExpandedChange(!expanded)
    }
    val mode = previewHeaderMode(ui)
    val surface = when {
        !disclosure.currentState && !disclosure.targetState -> Color.Transparent
        choice == "drawer" -> VoiceInk.surface
        else -> VoiceInk.ground
    }
    key(choice, density) {
        BoxWithConstraints(modifier.fillMaxWidth().testTag("preview-header")) {
            val side = if (maxWidth < 360.dp) 22.dp else 30.dp
            Column(Modifier.fillMaxWidth().background(surface)
                .onFocusChanged { focused = it.hasFocus }.focusGroup()
                .hoverable(hoverSource)
                .pointerInput(choice) {
                    try {
                        awaitPointerEventScope {
                            while (true) {
                                val event = awaitPointerEvent(PointerEventPass.Initial)
                                touching = event.changes.any { it.pressed }
                                interactionRevision++
                            }
                        }
                    } finally { touching = false }
                }.testTag("preview-header-$choice")) {
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = side)
                    .onSizeChanged { railHeight = it.height }, verticalAlignment = Alignment.CenterVertically) {
                    when (choice) {
                        "quiet" -> {
                            Row(Modifier.weight(1f).heightIn(min = 48.dp)
                                .headerReveal(expanded, reveal), verticalAlignment = Alignment.CenterVertically) {
                                HeaderText("Preview", "preview-header-label", color = VoiceInk.muted, size = 11)
                                Spacer(Modifier.width(12.dp))
                                HeaderMode(mode)
                                Spacer(Modifier.width(8.dp))
                                HeaderChevron(expanded, Modifier.size(12.dp))
                            }
                            HeaderExit(onExit, iconOnly = true)
                        }
                        "drawer" -> {
                            Box(Modifier.weight(1f), contentAlignment = Alignment.TopCenter) {
                                Column(Modifier.widthIn(min = 136.dp, max = 240.dp)
                                    .heightIn(min = 48.dp)
                                    .background(VoiceInk.surface, RoundedCornerShape(bottomStart = 9.dp, bottomEnd = 9.dp))
                                    .headerReveal(expanded, reveal).padding(horizontal = 16.dp, vertical = 8.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Box(Modifier.size(width = 24.dp, height = 2.dp).background(VoiceInk.muted)
                                        .clearAndSetSemantics { }.testTag("preview-header-handle"))
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        HeaderText("Preview", "preview-header-label", color = VoiceInk.muted, size = 11)
                                        if (expanded) {
                                            Spacer(Modifier.width(12.dp))
                                            HeaderMode(mode)
                                        }
                                        Spacer(Modifier.width(10.dp))
                                        HeaderChevron(expanded, Modifier.size(12.dp))
                                    }
                                }
                            }
                        }
                        "none" -> {
                            if (expanded) HeaderMode(mode)
                            Spacer(Modifier.weight(1f))
                            Row(Modifier.heightIn(min = 48.dp).widthIn(min = 108.dp)
                                .background(VoiceInk.ground, RoundedCornerShape(24.dp))
                                .border(1.dp, VoiceInk.line, RoundedCornerShape(24.dp))
                                .headerReveal(expanded, reveal).padding(horizontal = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally)) {
                                HeaderText("Preview", "preview-header-label", color = VoiceInk.muted, size = 11)
                                if (expanded) HeaderChevron(true, Modifier.size(12.dp))
                                else Canvas(Modifier.size(12.dp).clearAndSetSemantics { }.testTag("preview-header-menu-glyph")) {
                                    for (x in listOf(.15f, .5f, .85f)) {
                                        drawCircle(VoiceInk.muted, radius = 1.dp.toPx(), center = Offset(size.width * x, size.height / 2))
                                    }
                                }
                            }
                        }
                    }
                }
                // Compose's duration scale makes both the disclosure and its exit instantaneous
                // when Android animations are disabled.
                AnimatedVisibility(visibleState = disclosure,
                    enter = expandVertically(tween(280, easing = FastOutSlowInEasing), expandFrom = Alignment.Top) + fadeIn(tween(180)),
                    exit = shrinkVertically(tween(280, easing = FastOutSlowInEasing), shrinkTowards = Alignment.Top) + fadeOut(tween(120))) {
                    Column(Modifier.fillMaxWidth().onSizeChanged { detailsHeight = it.height }
                        .padding(horizontal = side).testTag("preview-header-details")) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                            HeaderChannel("YOU", if (ui.micOpen) "Open" else if (ui.micMuted) "Muted" else "On",
                                if (ui.micMuted && !ui.micOpen) VoiceInk.muted else VoiceInk.you,
                                "microphone", Modifier.weight(1f))
                            HeaderChannel("AGENT", if (ui.speakerMuted) "Muted" else "On",
                                if (ui.speakerMuted) VoiceInk.muted else VoiceInk.agent,
                                "speaker", Modifier.weight(1f))
                        }
                        if (choice != "quiet") {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween) {
                                if (choice == "drawer") HeaderPin(keepOpen) {
                                    keepOpen = !keepOpen
                                    interactionRevision++
                                } else Spacer(Modifier.width(1.dp))
                                HeaderExit(onExit)
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }
        }
    }
}

private data class HeaderModeValue(val label: String, val color: Color)

private fun previewHeaderMode(ui: CallUi): HeaderModeValue = when {
    ui.message != null -> HeaderModeValue("Needs attention", VoiceInk.text)
    else -> when (personaState(ui)) {
        PersonaState.Asleep -> HeaderModeValue("Paused", VoiceInk.muted)
        PersonaState.Idle -> HeaderModeValue("Idle", VoiceInk.text)
        PersonaState.Listening -> HeaderModeValue("Listening", VoiceInk.you)
        PersonaState.Speaking -> HeaderModeValue("Speaking", VoiceInk.agent)
    }
}

private fun Modifier.headerReveal(expanded: Boolean, reveal: () -> Unit): Modifier =
    clickable(role = Role.Button, onClickLabel = if (expanded) "Hide preview details" else "Show preview details", onClick = reveal)
        .semantics(mergeDescendants = true) {
            contentDescription = "Preview details"
            stateDescription = if (expanded) "Expanded" else "Collapsed"
            if (expanded) collapse(label = "Hide preview details") { reveal(); true }
            else expand(label = "Show preview details") { reveal(); true }
        }.testTag("preview-header-reveal")

@Composable
private fun HeaderMode(mode: HeaderModeValue) {
    HeaderText(mode.label, "preview-header-mode", color = mode.color, size = 11,
        modifier = Modifier.semantics { contentDescription = "Synthetic ${mode.label.lowercase()} state" })
}

@Composable
private fun HeaderChannel(name: String, state: String, color: Color, channel: String, modifier: Modifier) {
    Row(modifier.heightIn(min = 44.dp).semantics(mergeDescendants = true) {
        contentDescription = "Preview $channel"
        stateDescription = state
    }.testTag("preview-header-$channel"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        HeaderText(name, "preview-header-$channel-label", color = color, size = 11)
        HeaderText(state, "preview-header-$channel-state", color = VoiceInk.muted, size = 11)
    }
}

@Composable
private fun HeaderExit(onExit: () -> Unit, iconOnly: Boolean = false) {
    Row(Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp)
        .clickable(role = Role.Button, onClickLabel = "Exit preview", onClick = onExit)
        .semantics(mergeDescendants = true) { contentDescription = "Exit preview" }
        .testTag("preview-header-exit").padding(horizontal = if (iconOnly) 15.dp else 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        Canvas(Modifier.size(if (iconOnly) 18.dp else 12.dp).clearAndSetSemantics { }.testTag("preview-header-exit-glyph")) {
            val inset = 2.dp.toPx()
            drawLine(VoiceInk.muted, Offset(inset, inset), Offset(size.width - inset, size.height - inset), 1.5.dp.toPx(), StrokeCap.Round)
            drawLine(VoiceInk.muted, Offset(size.width - inset, inset), Offset(inset, size.height - inset), 1.5.dp.toPx(), StrokeCap.Round)
        }
        if (!iconOnly) HeaderText("Exit preview", "preview-header-exit-label", size = 11)
    }
}

@Composable
private fun HeaderPin(pinned: Boolean, toggle: () -> Unit) {
    Row(Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp)
        .clickable(role = Role.Switch, onClickLabel = if (pinned) "Allow preview details to hide" else "Keep preview details open", onClick = toggle)
        .semantics(mergeDescendants = true) {
            contentDescription = "Keep preview details open"
            toggleableState = if (pinned) ToggleableState.On else ToggleableState.Off
            stateDescription = if (pinned) "On" else "Off; hides after inactivity"
        }.testTag("preview-header-pin").padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Canvas(Modifier.size(12.dp).clearAndSetSemantics { }.testTag("preview-header-pin-glyph")) {
            val inset = 1.dp.toPx()
            drawRect(if (pinned) VoiceInk.you else VoiceInk.muted, Offset(inset, inset),
                androidx.compose.ui.geometry.Size(size.width - inset * 2, size.height - inset * 2), style = Stroke(1.dp.toPx()))
            if (pinned) {
                drawLine(VoiceInk.you, Offset(size.width * .25f, size.height * .5f), Offset(size.width * .45f, size.height * .7f), 1.dp.toPx())
                drawLine(VoiceInk.you, Offset(size.width * .45f, size.height * .7f), Offset(size.width * .78f, size.height * .3f), 1.dp.toPx())
            }
        }
        HeaderText("Keep open", "preview-header-pin-label", color = if (pinned) VoiceInk.you else VoiceInk.muted, size = 11)
    }
}

@Composable
private fun HeaderChevron(expanded: Boolean, modifier: Modifier) {
    Canvas(modifier.clearAndSetSemantics { }.testTag("preview-header-chevron")) {
        val edge = if (expanded) .65f else .35f
        val center = if (expanded) .35f else .65f
        drawLine(VoiceInk.muted, Offset(size.width * .2f, size.height * edge), Offset(size.width * .5f, size.height * center), 1.2.dp.toPx(), StrokeCap.Round)
        drawLine(VoiceInk.muted, Offset(size.width * .5f, size.height * center), Offset(size.width * .8f, size.height * edge), 1.2.dp.toPx(), StrokeCap.Round)
    }
}

@Composable
private fun HeaderText(text: String, tag: String, modifier: Modifier = Modifier, color: Color = VoiceInk.text, size: Int = 12) {
    Text(text, modifier.testTag(tag), color = color, fontFamily = VoiceInk.type, fontSize = size.sp,
        maxLines = 1, overflow = TextOverflow.Ellipsis, letterSpacing = .1.sp)
}
