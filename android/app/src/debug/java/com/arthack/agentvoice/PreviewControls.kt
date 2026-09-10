package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.input.pointer.isOutOfBounds
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

/** Debug-only controls. All state and operations belong to the synthetic preview owner. */
@Composable
internal fun PreviewControls(
    ui: CallUi,
    onMute: (String) -> Unit,
    onHold: () -> Unit,
    onRelease: () -> Unit,
    modifier: Modifier = Modifier,
    controlsHeightDp: Int = DEFAULT_PREVIEW_CONTROLS_HEIGHT_DP,
    holdSharePercent: Double = DEFAULT_PREVIEW_HOLD_SHARE_PERCENT,
    light: State<PreviewButtonLight>? = null,
    spacing: PreviewSpacing = PreviewSpacing(),
    availableHeightDp: Float? = null,
    onReleaseCompleted: () -> Unit = onRelease,
    showPushToTalk: Boolean = true,
    landscape: Boolean = false,
    mirror: Boolean = false,
) {
    if (landscape) {
        PreviewLandscapeControls(ui, onMute, onHold, onRelease, modifier, controlsHeightDp,
            holdSharePercent, light, spacing, availableHeightDp, onReleaseCompleted, showPushToTalk, mirror)
        return
    }
    val inks = LocalPreviewTheme.current.palette
    val geometry = PreviewControlGeometry(controlsHeightDp, holdSharePercent, spacing.effectivePushGapDp, showPushToTalk)
    val fit = geometry.fitWithin(availableHeightDp)
    // The old recognizer disposes during resize; its release must see the new owner's callback.
    val latestHold by rememberUpdatedState(onHold)
    val latestRelease by rememberUpdatedState(onRelease)
    val latestCompleted by rememberUpdatedState(onReleaseCompleted)
    Column(modifier.height(fit.extent.dp).testTag("preview-controls")) {
        PreviewMuteControls(ui, onMute, Modifier.fillMaxWidth().height(fit.mute.dp), light, spacing.effectiveChannelGapDp)
        if (showPushToTalk) {
            Canvas(Modifier.fillMaxWidth().height(fit.gap.dp).clearAndSetSemantics { }) {
                if (size.height <= 0f) return@Canvas
                // Hold gates capture only; the conduit belongs to the microphone side of the deck.
                val x = (size.width - spacing.effectiveChannelGapDp.dp.toPx()) / 4f
                val ink = if (ui.canHold || ui.holding) inks.you else inks.line
                drawLine(ink, Offset(x, 0f), Offset(x, size.height), 3.dp.toPx())
                val capStroke = minOf(2.dp.toPx(), size.height)
                val capY = size.height - capStroke / 2f
                drawLine(ink, Offset(x - 8.dp.toPx(), capY),
                    Offset(x + 8.dp.toPx(), capY), capStroke)
            }
            key(geometry, fit) {
                PreviewHoldControl(ui, { latestHold() }, { latestRelease() },
                    Modifier.fillMaxWidth().height(fit.hold.dp), light, onReleaseCompleted = { latestCompleted() })
            }
        }
    }
}

@Composable
private fun PreviewLandscapeControls(
    ui: CallUi, onMute: (String) -> Unit, onHold: () -> Unit, onRelease: () -> Unit,
    modifier: Modifier, controlsHeightDp: Int, holdSharePercent: Double,
    light: State<PreviewButtonLight>?, spacing: PreviewSpacing, availableHeightDp: Float?,
    onReleaseCompleted: () -> Unit, showPushToTalk: Boolean, mirror: Boolean,
) {
    val inks = LocalPreviewTheme.current.palette
    val height = minOf(controlsHeightDp.toFloat(), availableHeightDp ?: controlsHeightDp.toFloat())
    BoxWithConstraints(modifier.height(height.dp).testTag("preview-controls")) {
        val gap = if (showPushToTalk) minOf(spacing.effectivePushGapDp.toFloat(), maxWidth.value / 4f) else 0f
        val holdWidth = if (showPushToTalk) maxWidth.value * holdSharePercent.toFloat() / 100f else 0f
        val muteWidth = (maxWidth.value - holdWidth - gap).coerceAtLeast(1f)
        val channelGap = minOf(spacing.effectiveChannelGapDp.toFloat(), height / 3f)
        val heightScale = ((height - channelGap) / 2f / 130f).coerceIn(.6f, 1.6f)
        val latestRelease by rememberUpdatedState(onRelease)
        val latestHold by rememberUpdatedState(onHold)
        val latestCompleted by rememberUpdatedState(onReleaseCompleted)
        @Composable fun muteColumn() {
            Column(Modifier.width(muteWidth.dp).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(channelGap.dp)) {
                PreviewMuteButton("HUMAN", "mic", ui.micMuted, ui.micOpen, ui.connected && !ui.controlsPending,
                    inks.you, heightScale, light, onMute, Modifier.fillMaxWidth().weight(1f))
                PreviewMuteButton("AGENT", "speaker", ui.speakerMuted, ui.speakerOpen, ui.connected && !ui.controlsPending,
                    inks.agent, heightScale, light, onMute, Modifier.fillMaxWidth().weight(1f))
            }
        }
        @Composable fun pushColumn() {
            key(height, holdWidth, gap) {
                PreviewHoldControl(ui, { latestHold() }, { latestRelease() },
                    Modifier.width(holdWidth.dp).fillMaxHeight(), light, onReleaseCompleted = { latestCompleted() })
            }
        }
        @Composable fun conduit() {
            Canvas(Modifier.width(gap.dp).fillMaxHeight().clearAndSetSemantics { }) {
                val y = (size.height - channelGap.dp.toPx()) / 4f
                val ink = if (ui.canHold || ui.holding) inks.you else inks.line
                drawLine(ink, Offset(0f, y), Offset(size.width, y), 3.dp.toPx())
                val cap = if (mirror) 0f else size.width
                drawLine(ink, Offset(cap, y - 8.dp.toPx()), Offset(cap, y + 8.dp.toPx()), 2.dp.toPx())
            }
        }
        Row(Modifier.fillMaxSize()) {
            if (showPushToTalk && mirror) { pushColumn(); conduit() }
            muteColumn()
            if (showPushToTalk && !mirror) { conduit(); pushColumn() }
        }
    }
}

@Composable
internal fun PreviewMuteControls(
    ui: CallUi,
    onMute: (String) -> Unit,
    modifier: Modifier = Modifier,
    light: State<PreviewButtonLight>? = null,
    channelGapDp: Int = 10,
) {
    val inks = LocalPreviewTheme.current.palette
    BoxWithConstraints(modifier) {
        val heightScale = (maxHeight.value / 130f).coerceIn(.6f, 1.6f)
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(channelGapDp.dp)) {
            PreviewMuteButton("HUMAN", "mic", ui.micMuted, ui.micOpen, ui.connected && !ui.controlsPending,
                inks.you, heightScale, light, onMute, Modifier.weight(1f).fillMaxHeight())
            PreviewMuteButton("AGENT", "speaker", ui.speakerMuted, ui.speakerOpen, ui.connected && !ui.controlsPending,
                inks.agent, heightScale, light, onMute, Modifier.weight(1f).fillMaxHeight())
        }
    }
}

@Composable
private fun PreviewMuteButton(
    name: String,
    target: String,
    muted: Boolean,
    open: Boolean,
    enabled: Boolean,
    ink: Color,
    heightScale: Float,
    light: State<PreviewButtonLight>?,
    onMute: (String) -> Unit,
    modifier: Modifier,
) {
    val inks = LocalPreviewTheme.current.palette
    val currentOnMute by rememberUpdatedState(onMute)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()
    val on = !muted || open
    val color = if (enabled && on) ink else inks.muted
    val status = when { !enabled -> "wait"; muted && open -> "live"; muted -> "off"; else -> "on" }
    Box(modifier.clickable(interactionSource = interaction, indication = null, enabled = enabled,
        role = Role.Switch, onClickLabel = if (muted) "Unmute $name" else "Mute $name",
        onClick = { currentOnMute(target) })
        .semantics(mergeDescendants = true) {
            contentDescription = if (target == "speaker") "AGENT speaker" else "HUMAN microphone"
            toggleableState = if (muted) ToggleableState.Off else ToggleableState.On
            stateDescription = when {
                muted && open -> "Talking; muted on release"
                !enabled -> if (muted) "Muted; unavailable" else "On; unavailable"
                muted -> "Muted"
                else -> "On"
            }
        }.testTag(if (target == "speaker") "speaker-mute" else "mic-mute")) {
        val face = Modifier.fillMaxSize().clearAndSetSemantics { }
        // Momentary capture never moves the persistent mute switch to its on position.
        RockerMuteFace(name, target == "speaker", muted, color, status, pressed, heightScale,
            face, light, enabled && !muted && open)
        if (focused) Canvas(Modifier.matchParentSize().clearAndSetSemantics { }) {
            drawCutPlate(inks.text, cut = 5.dp.toPx(), inset = 1.dp.toPx(), stroke = 2.dp.toPx())
        }
    }
}

@Composable
internal fun RockerMuteFace(
    name: String, speaker: Boolean, muted: Boolean, color: Color,
    status: String, pressed: Boolean, heightScale: Float, modifier: Modifier,
    light: State<PreviewButtonLight>?, lightEnabled: Boolean,
) {
    val theme = LocalPreviewTheme.current
    val inks = theme.palette
    val sink = if (pressed) 2.dp else 0.dp
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier) {
        val topPadding = (18f * heightScale).coerceIn(10f, 28f).dp
        val bottomPadding = (14f * heightScale).coerceIn(8f, 22f).dp
        val glyphSize = (46f * heightScale).coerceIn(30f, 72f).dp
        val caption = remember(name, maxWidth, maxHeight, heightScale, density, measurer) { with(density) {
            rockerCaption(measurer, name, maxWidth.toPx(),
                (maxHeight - topPadding - bottomPadding - glyphSize - 2.dp).toPx(),
                heightScale, 1.dp.toPx())
        } }
        Column(Modifier.fillMaxSize().drawBehind {
            val edge = 5.dp.toPx()
            val seam = size.height * if (muted) .65f else .72f
            val top = (if (muted) 9.dp else 4.dp).toPx() + sink.toPx()
            drawCutPlate(inks.line, cut = 10.dp.toPx())
            drawCutPlate(inks.ground, cut = 7.dp.toPx(), inset = 2.dp.toPx())
            val upperFace = Path().apply {
                moveTo(edge + 3.dp.toPx(), top)
                lineTo(size.width - edge - 3.dp.toPx(), top)
                lineTo(size.width - edge, top + 4.dp.toPx())
                lineTo(size.width - edge - 3.dp.toPx(), seam)
                lineTo(edge + 3.dp.toPx(), seam)
                lineTo(edge, top + 4.dp.toPx()); close()
            }
            drawPath(upperFace, if (muted) inks.surface else color.copy(alpha = .12f))
            drawPreviewButtonLight(upperFace, light, lightEnabled, capture = !speaker, ink = color, strength = theme.decorationStrength)
            drawPath(Path().apply {
                moveTo(edge + 3.dp.toPx(), seam + 2.dp.toPx())
                lineTo(size.width - edge - 3.dp.toPx(), seam + 2.dp.toPx())
                lineTo(size.width - edge, size.height - edge - if (muted) 4.dp.toPx() else 0f)
                lineTo(edge, size.height - edge - if (muted) 4.dp.toPx() else 0f); close()
            }, if (muted) inks.line else inks.surface)
            drawLine(if (muted) inks.line else color.copy(alpha = .7f),
                Offset(edge + 6.dp.toPx(), top), Offset(size.width - edge - 6.dp.toPx(), top), 2.dp.toPx())
        }.padding(top = topPadding + sink, bottom = bottomPadding - sink),
            verticalArrangement = Arrangement.SpaceBetween) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween) {
                ChunkyChannelGlyph(speaker, muted, color,
                    if (muted) inks.surface else color.copy(alpha = .12f).over(inks.ground),
                    Modifier.size(glyphSize).testTag("rocker-channel-glyph"))
                BinaryDetent(!muted, color, Modifier.width(12.dp).height((38f * heightScale).coerceIn(24f, 48f).dp))
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = caption.inset)) {
                Text(name, modifier = Modifier.weight(1f).alignByBaseline().testTag("rocker-channel-caption"),
                    color = color, style = caption.name, maxLines = 1, softWrap = false)
                Spacer(Modifier.width(6.dp))
                Text(status, modifier = Modifier.width(with(density) { caption.statusWidth.toDp() })
                    .alignByBaseline().testTag("rocker-state-caption"),
                    color = if (muted) inks.text else inks.muted, style = caption.status,
                    textAlign = TextAlign.End, maxLines = 1, softWrap = false)
            }
        }
    }
}

private data class RockerCaption(val name: TextStyle, val status: TextStyle, val inset: Dp, val statusWidth: Float)

private fun rockerCaption(measurer: TextMeasurer, name: String, width: Float, height: Float,
    heightScale: Float, unit: Float): RockerCaption {
    fun candidate(nameSize: Int, statusSize: Int, inset: Dp): Pair<RockerCaption, Boolean> {
        fun style(size: Int, weight: FontWeight) = TextStyle(fontFamily = VoiceInk.type, fontSize = size.sp,
            fontWeight = weight, letterSpacing = 0.sp, lineHeight = (size * 1.15f).sp)
        val nameStyle = style(nameSize, FontWeight.Normal)
        val statusStyle = style(statusSize, FontWeight.SemiBold)
        val nameLayout = measurer.measure(name, nameStyle, maxLines = 1, softWrap = false)
        // Reserve the same slot in every state; a gate change cannot move or hide a caption.
        val states = listOf("on", "off", "live", "wait").map {
            measurer.measure(it, statusStyle, maxLines = 1, softWrap = false)
        }
        val statusWidth = states.maxOf { it.size.width }.toFloat()
        val fits = nameLayout.size.width + statusWidth + (inset.value * 2f + 6f) * unit <= width &&
            maxOf(nameLayout.size.height, states.maxOf { it.size.height }) <= height
        return RockerCaption(nameStyle, statusStyle, inset, statusWidth) to fits
    }
    val normal = candidate(scaledType(14, heightScale, 12, 18), scaledType(16, heightScale, 14, 18), 18.dp)
    return if (normal.second) normal.first else candidate(12, 14, 12.dp).first
}

@Composable
internal fun PreviewHoldControl(
    ui: CallUi,
    onHold: () -> Unit,
    onRelease: () -> Unit,
    modifier: Modifier = Modifier,
    light: State<PreviewButtonLight>? = null,
    onReleaseCompleted: () -> Unit = onRelease,
) {
    val inks = LocalPreviewTheme.current.palette
    val latestUi by rememberUpdatedState(ui)
    val latestHold by rememberUpdatedState(onHold)
    val latestRelease by rememberUpdatedState(onRelease)
    val latestCompleted by rememberUpdatedState(onReleaseCompleted)
    var ownsHold by remember { mutableStateOf(false) }
    var hasOwnedHold by remember { mutableStateOf(false) }
    var touchingLive by remember { mutableStateOf(false) }
    val canAcknowledgeTouch = microphoneIsLive(ui) && !ui.canHold && !ui.holding
    val releaseOwned by rememberUpdatedState({ completed: Boolean ->
        if (ownsHold) {
            ownsHold = false
            if (completed) latestCompleted() else latestRelease()
        }
    })
    DisposableEffect(Unit) {
        onDispose {
            if (ownsHold) releaseOwned(false) else if (!hasOwnedHold && latestUi.holding) latestRelease()
        }
    }
    LaunchedEffect(ui.canHold) { if (!ui.canHold) releaseOwned(false) }
    LaunchedEffect(canAcknowledgeTouch) { if (!canAcknowledgeTouch) touchingLive = false }
    val live = ui.holding && ui.micOpen
    val acknowledgedTouch = touchingLive && canAcknowledgeTouch
    val ink = when {
        ui.canHold || ui.holding -> inks.you
        acknowledgedTouch -> androidx.compose.ui.graphics.lerp(inks.muted, inks.you, .18f)
        else -> inks.muted
    }
    val surface = when {
        live -> inks.you.copy(alpha = .08f).over(inks.surface)
        acknowledgedTouch -> inks.you.copy(alpha = .025f).over(inks.surface)
        else -> inks.surface
    }
    Box(modifier.pointerInput(Unit) {
        awaitEachGesture {
            val down = awaitFirstDown()
            down.consume()
            if (microphoneIsLive(latestUi) && !latestUi.canHold && !latestUi.holding) {
                // This finger acknowledges an already-open mic; it can never acquire a PTT hold.
                touchingLive = true
                try {
                    while (true) {
                        val event = awaitPointerEvent()
                        val pointer = event.changes.firstOrNull { it.id == down.id }
                        if (!microphoneIsLive(latestUi) || latestUi.canHold || latestUi.holding ||
                            pointer == null || !pointer.pressed || pointer.isConsumed ||
                            pointer.isOutOfBounds(size, extendedTouchPadding) ||
                            event.changes.any { it.id != down.id && it.pressed }) break
                        pointer.consume()
                    }
                } finally { touchingLive = false }
            } else if (latestUi.canHold && !ownsHold) {
                hasOwnedHold = true
                ownsHold = true
                var completed = false
                try {
                    latestHold()
                    while (true) {
                        val event = awaitPointerEvent()
                        val pointer = event.changes.firstOrNull { it.id == down.id }
                        if (!latestUi.canHold || pointer == null || pointer.isConsumed ||
                            pointer.isOutOfBounds(size, extendedTouchPadding) ||
                            event.changes.any { it.id != down.id && it.pressed }) break
                        if (!pointer.pressed) { completed = true; break }
                        pointer.consume()
                    }
                } finally { releaseOwned(completed) }
            }
        }
    }.semantics(mergeDescendants = true) {
        role = Role.Button
        contentDescription = "Push to talk"
        stateDescription = when {
            microphoneIsLive(ui) -> if (ui.holding) "Live now. Release to mute" else "Live now. Microphone open"
            ui.holding -> "Opening microphone"
            ui.canHold -> "Ready"
            else -> "Unavailable. ${holdUnavailableReason(ui)}"
        }
        if (!ui.canHold && !ui.holding) disabled()
        // Accessibility owns an explicit start/stop, never a simulated timed pointer press.
        customActions = if (!ui.canHold && !ui.holding) emptyList() else listOf(
            CustomAccessibilityAction(if (ui.holding) "Stop talking" else "Start talking") {
                when {
                    latestUi.holding || ownsHold -> {
                        if (ownsHold) releaseOwned(true) else latestCompleted()
                        true
                    }
                    latestUi.canHold -> {
                        hasOwnedHold = true
                        ownsHold = true
                        latestHold()
                        true
                    }
                    else -> false
                }
            })
    }.testTag("hold-to-talk")) {
        val face = Modifier.fillMaxSize().clearAndSetSemantics { }
        RockerHoldFace(ui, ink, surface, face, light, acknowledgedTouch)
    }
}

@Composable
private fun RockerHoldFace(
    ui: CallUi, ink: Color, surface: Color, modifier: Modifier, light: State<PreviewButtonLight>?,
    acknowledgedTouch: Boolean,
) {
    val theme = LocalPreviewTheme.current
    val inks = theme.palette
    val largeType = LocalDensity.current.fontScale > 1.3f
    val live = ui.holding && ui.micOpen
    val microphoneLive = microphoneIsLive(ui)
    BoxWithConstraints(modifier) {
        val verticalFace = maxHeight > maxWidth * 1.15f
        val heightScale = (maxHeight.value / 116f).coerceIn(.6f, 1.6f)
        val liveTypeMaximum = if (maxWidth < 300.dp) 24 else 28
        val compactFace = largeType || maxWidth < 300.dp
        val concise = compactFace || maxHeight < 100.dp
        val shallow = (4f * heightScale).coerceIn(3f, 6f).dp
        val deep = (7f * heightScale).coerceIn(5f, 10f).dp
        val upperInset = if (ui.holding) deep else shallow
        val lowerInset = if (ui.holding) shallow else deep
        val faceModifier = Modifier.fillMaxSize().drawBehind {
            val cut = (12f * heightScale).coerceIn(8f, 16f).dp.toPx()
            val top = upperInset.toPx()
            val bottom = size.height - lowerInset.toPx()
            val upperSide = if (ui.holding) 9.dp.toPx() else 6.dp.toPx()
            val lowerSide = if (ui.holding) 6.dp.toPx() else 9.dp.toPx()
            val corner = (6f * heightScale).coerceIn(4f, 9f).dp.toPx()
            drawCutPlate(inks.line, cut = cut)
            drawCutPlate(inks.ground, cut = cut - 2.dp.toPx(), inset = 2.dp.toPx())
            val pivot = size.height / 2f
            drawLine(inks.muted.copy(alpha = .45f), Offset(3.dp.toPx(), pivot),
                Offset(size.width - 3.dp.toPx(), pivot), 3.dp.toPx())
            val face = Path().apply {
                moveTo(upperSide + corner, top); lineTo(size.width - upperSide - corner, top)
                lineTo(size.width - upperSide, top + corner)
                lineTo(size.width - lowerSide, bottom - corner)
                lineTo(size.width - lowerSide - corner, bottom)
                lineTo(lowerSide + corner, bottom); lineTo(lowerSide, bottom - corner)
                lineTo(upperSide, top + corner); close()
            }
            val bevel = if (ui.holding) 1.dp.toPx() else 2.dp.toPx()
            drawPath(Path().apply {
                moveTo(lowerSide, bottom - corner); lineTo(lowerSide + corner, bottom)
                lineTo(size.width - lowerSide - corner, bottom)
                lineTo(size.width - lowerSide, bottom - corner)
                lineTo(size.width - lowerSide, bottom + bevel - corner)
                lineTo(size.width - lowerSide - corner, bottom + bevel)
                lineTo(lowerSide + corner, bottom + bevel)
                lineTo(lowerSide, bottom + bevel - corner); close()
            }, inks.line)
            drawPath(face, surface)
            drawPreviewButtonLight(face, light, ui.connected && !ui.controlsPending && live,
                capture = true, ink = inks.you, strength = theme.decorationStrength)
            drawPath(face, inks.line, style = Stroke(1.dp.toPx()))
            // Only PTT rocks the face; an already-open microphone gets a quieter touch acknowledgement.
            val lip = when {
                live -> ink.copy(alpha = .65f)
                acknowledgedTouch -> inks.you.copy(alpha = .3f)
                ui.canHold && !ui.holding -> ink.copy(alpha = .24f)
                else -> inks.line
            }
            val lipY = if (ui.holding) bottom else top
            val lipInset = (if (ui.holding) lowerSide else upperSide) + corner + 4.dp.toPx()
            drawLine(lip, Offset(lipInset, lipY), Offset(size.width - lipInset, lipY), 1.5.dp.toPx())
        }.padding(start = if (verticalFace) 10.dp else if (compactFace) 20.dp else 24.dp, top = upperInset,
            end = if (verticalFace) 10.dp else if (compactFace) 20.dp else 24.dp, bottom = lowerInset)
        if (verticalFace) {
            val fontScale = LocalDensity.current.fontScale
            val mainSize = ((maxWidth.value - 24f) / (2.6f * fontScale)).toInt().coerceIn(14, 32)
            val glyphSize = minOf(42f, maxWidth.value * .35f).dp
            Column(faceModifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                RockerPressGlyph(ink, ui.holding, Modifier.size(glyphSize))
                Spacer(Modifier.height(16.dp))
                ControlText(when {
                    microphoneLive -> "Live\nnow"
                    ui.holding -> "Wait"
                    ui.canHold -> "Push"
                    else -> "Off"
                }, ink, mainSize, bold = true, maxLines = 2, align = TextAlign.Center)
                Spacer(Modifier.height(8.dp))
                ControlText(when {
                    microphoneLive -> if (ui.holding) "release\nto mute" else "mic open"
                    ui.holding -> "for mic"
                    ui.canHold -> "to talk"
                    else -> holdUnavailableReason(ui, concise = true)
                }, ink, 11, maxLines = 4, align = TextAlign.Center)
            }
        } else Row(faceModifier, verticalAlignment = Alignment.CenterVertically) {
            RockerPressGlyph(ink, ui.holding,
                Modifier.size(((if (compactFace) 28f else 36f) * heightScale).coerceIn(26f, 48f).dp))
            Spacer(Modifier.width(if (compactFace) 14.dp else 20.dp))
            Column(Modifier.weight(1f)) {
                ControlText(when {
                    microphoneLive -> "Live now"
                    ui.holding -> if (concise) "Wait" else "Opening"
                    ui.canHold -> "Push"
                    else -> if (concise) "Off" else "Unavailable"
                }, ink, when {
                    microphoneLive -> scaledType(24, heightScale, 19, liveTypeMaximum)
                    !ui.canHold && !ui.holding -> scaledType(22, heightScale, 18, 26)
                    else -> scaledType(32, heightScale, 23, 42)
                }, bold = true)
                Spacer(Modifier.height((3f * heightScale).coerceIn(2f, 5f).dp))
                ControlText(when {
                    microphoneLive -> if (ui.holding) "release to mute" else "microphone open"
                    ui.holding -> if (concise) "for microphone" else "microphone"
                    ui.canHold -> "to talk"
                    else -> holdUnavailableReason(ui, concise = concise)
                }, ink, scaledType(11, heightScale, 10, 14), maxLines = 2)
            }
        }
    }
}

private fun scaledType(base: Int, heightScale: Float, minimum: Int, maximum: Int): Int =
    (base * heightScale).roundToInt().coerceIn(minimum, maximum)

private fun microphoneIsLive(ui: CallUi): Boolean = ui.connected && !ui.controlsPending && ui.micOpen

private fun holdUnavailableReason(ui: CallUi, concise: Boolean = false): String = when {
    !ui.connected -> if (concise) "Not connected" else "Voice not connected"
    ui.controlsPending -> if (concise) "Updating" else "Updating controls"
    !ui.micMuted -> "Opening microphone"
    else -> if (concise) "Waiting for mic" else "Waiting for microphone"
}

@Composable
private fun ControlText(text: String, color: Color, size: Int, bold: Boolean = false, maxLines: Int = 1, align: TextAlign = TextAlign.Start) {
    Text(text, textAlign = align, color = color, fontFamily = VoiceInk.type, fontSize = size.sp,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
        letterSpacing = 0.sp, lineHeight = (size * 1.15f).sp, maxLines = maxLines)
}

@Composable
private fun BinaryDetent(on: Boolean, ink: Color, modifier: Modifier) {
    val inks = LocalPreviewTheme.current.palette
    Canvas(modifier) {
        drawLine(if (on) ink else inks.line, Offset(size.width / 2, 2.dp.toPx()),
            Offset(size.width / 2, 12.dp.toPx()), 3.dp.toPx())
        drawCircle(if (on) inks.line else ink, radius = 4.dp.toPx(),
            center = Offset(size.width / 2, size.height - 6.dp.toPx()), style = Stroke(2.dp.toPx()))
    }
}

@Composable
private fun ChunkyChannelGlyph(speaker: Boolean, muted: Boolean, ink: Color, ground: Color, modifier: Modifier) {
    Canvas(modifier) {
        val unit = size.minDimension / 64f
        translate((size.width - 64 * unit) / 2f, (size.height - 64 * unit) / 2f) {
            scale(unit, unit, Offset.Zero) {
                if (speaker) {
                    drawPath(Path().apply {
                        moveTo(7f, 23f); lineTo(19f, 23f); lineTo(35f, 10f)
                        lineTo(35f, 54f); lineTo(19f, 41f); lineTo(7f, 41f); close()
                    }, ink)
                    if (!muted) {
                        drawRoundRect(ink, Offset(42f, 23f), Size(6f, 18f), CornerRadius(1f))
                        drawRoundRect(ink, Offset(53f, 14f), Size(6f, 36f), CornerRadius(1f))
                    }
                } else {
                    drawRoundRect(ink, Offset(23f, 5f), Size(18f, 33f), CornerRadius(9f))
                    repeat(3) { row -> drawLine(ground, Offset(27f, 13f + row * 6f),
                        Offset(37f, 13f + row * 6f), 2.5f) }
                    drawPath(Path().apply {
                        moveTo(14f, 27f); lineTo(14f, 32f)
                        cubicTo(14f, 55f, 50f, 55f, 50f, 32f); lineTo(50f, 27f)
                    }, ink, style = Stroke(5.5f, cap = StrokeCap.Square, join = StrokeJoin.Round))
                    drawRect(ink, Offset(29f, 47f), Size(6f, 10f))
                    drawRect(ink, Offset(20f, 56f), Size(24f, 5f))
                }
                if (muted) {
                    drawLine(ground, Offset(8f, 7f), Offset(56f, 57f), 11f, StrokeCap.Square)
                    drawLine(ink, Offset(8f, 7f), Offset(56f, 57f), 5.5f, StrokeCap.Square)
                }
            }
        }
    }
}

@Composable
private fun RockerPressGlyph(ink: Color, pressed: Boolean, modifier: Modifier) {
    Canvas(modifier) {
        val unit = size.minDimension / 48f
        scale(unit, unit, Offset.Zero) {
            val drop = if (pressed) 3f else 0f
            drawRect(ink, Offset(20f, 2f + drop), Size(8f, 18f))
            drawPath(Path().apply {
                moveTo(9f, 17f + drop); lineTo(39f, 17f + drop)
                lineTo(24f, 32f + drop); close()
            }, ink)
            drawRoundRect(ink, Offset(7f, 36f), Size(34f, 4f), CornerRadius(1f))
            drawRoundRect(ink.copy(alpha = .55f), Offset(11f, 44f), Size(26f, 3f), CornerRadius(1f))
        }
    }
}

private fun DrawScope.drawCutPlate(
    color: Color, cut: Float, inset: Float = 0f, stroke: Float = 0f,
) {
    val left = inset
    val right = size.width - inset
    val upper = inset
    val lower = size.height - inset
    val corner = cut.coerceAtMost((right - left) / 2).coerceAtMost((lower - upper) / 2)
    val path = Path().apply {
        moveTo(left + corner, upper); lineTo(right - corner, upper)
        lineTo(right, upper + corner); lineTo(right, lower - corner)
        lineTo(right - corner, lower); lineTo(left + corner, lower)
        lineTo(left, lower - corner); lineTo(left, upper + corner); close()
    }
    if (stroke > 0f) drawPath(path, color, style = Stroke(stroke)) else drawPath(path, color)
}

private fun Color.over(ground: Color): Color = Color(
    red * alpha + ground.red * (1 - alpha),
    green * alpha + ground.green * (1 - alpha),
    blue * alpha + ground.blue * (1 - alpha),
)
