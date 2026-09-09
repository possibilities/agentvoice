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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

/** Debug-only controls. All state and operations belong to the synthetic preview owner. */
@Composable
internal fun PreviewControls(
    ui: CallUi,
    muteStyle: String,
    holdStyle: String,
    onMute: (String) -> Unit,
    onHold: () -> Unit,
    onRelease: () -> Unit,
    modifier: Modifier = Modifier,
    controlsHeightDp: Int = DEFAULT_PREVIEW_CONTROLS_HEIGHT_DP,
    holdSharePercent: Double = DEFAULT_PREVIEW_HOLD_SHARE_PERCENT,
    light: State<PreviewButtonLight>? = null,
) {
    val geometry = PreviewControlGeometry(controlsHeightDp, holdSharePercent)
    // The old recognizer disposes during resize; its release must see the new owner's callback.
    val latestHold by rememberUpdatedState(onHold)
    val latestRelease by rememberUpdatedState(onRelease)
    Column(modifier.height(geometry.controlsHeightDp.dp).testTag("preview-controls")) {
        PreviewMuteControls(ui, muteStyle, onMute, Modifier.fillMaxWidth().height(geometry.muteHeightDp.dp), light)
        Canvas(Modifier.fillMaxWidth().height(PREVIEW_CONTROL_CONDUIT_DP.dp).clearAndSetSemantics { }) {
            // Hold gates capture only; the conduit belongs to the microphone side of the deck.
            val x = (size.width - 10.dp.toPx()) / 4f
            val ink = if (ui.canHold || ui.holding) VoiceInk.you else VoiceInk.line
            drawLine(ink, Offset(x, 0f), Offset(x, size.height), 3.dp.toPx())
            drawLine(ink, Offset(x - 8.dp.toPx(), size.height - 1.dp.toPx()),
                Offset(x + 8.dp.toPx(), size.height - 1.dp.toPx()), 2.dp.toPx())
        }
        key(geometry) {
            PreviewHoldControl(ui, holdStyle, { latestHold() }, { latestRelease() },
                Modifier.fillMaxWidth().height(geometry.holdHeightDp.dp), light)
        }
    }
}

@Composable
internal fun PreviewMuteControls(
    ui: CallUi,
    style: String,
    onMute: (String) -> Unit,
    modifier: Modifier = Modifier,
    light: State<PreviewButtonLight>? = null,
) {
    BoxWithConstraints(modifier) {
        val heightScale = (maxHeight.value / 130f).coerceIn(.6f, 1.6f)
        Row(Modifier.fillMaxSize().drawBehind {
            if (style == "glyphs") {
                drawCutPlate(VoiceInk.surface, cut = 5.dp.toPx())
                drawLine(VoiceInk.line, Offset(size.width / 2, 17.dp.toPx()),
                    Offset(size.width / 2, size.height - 17.dp.toPx()), 1.dp.toPx())
            }
        }, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PreviewMuteButton("YOU", "mic", ui.micMuted, ui.micOpen, ui.connected && !ui.controlsPending,
                VoiceInk.you, style, heightScale, light, onMute, Modifier.weight(1f).fillMaxHeight())
            PreviewMuteButton("AGENT", "speaker", ui.speakerMuted, ui.speakerOpen, ui.connected && !ui.controlsPending,
                VoiceInk.agent, style, heightScale, light, onMute, Modifier.weight(1f).fillMaxHeight())
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
    style: String,
    heightScale: Float,
    light: State<PreviewButtonLight>?,
    onMute: (String) -> Unit,
    modifier: Modifier,
) {
    val currentOnMute by rememberUpdatedState(onMute)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()
    val on = !muted || open
    val color = if (enabled && on) ink else VoiceInk.muted
    val status = when { !enabled -> "wait"; muted && open -> "live"; muted -> "off"; else -> "on" }
    Box(modifier.clickable(interactionSource = interaction, indication = null, enabled = enabled,
        role = Role.Switch, onClickLabel = if (muted) "Unmute $name" else "Mute $name",
        onClick = { currentOnMute(target) })
        .semantics(mergeDescendants = true) {
            contentDescription = if (target == "speaker") "AGENT speaker" else "YOU microphone"
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
        when (style) {
            "rockers" -> RockerMuteFace(name, target == "speaker", muted, color, status, pressed, heightScale,
                face, light, enabled && !muted && open)
            "keycaps" -> KeycapMuteFace(name, target == "speaker", muted, color, pressed, heightScale,
                face, light, enabled && !muted && open)
            else -> GlyphMuteFace(name, target == "speaker", muted, color, status, pressed, heightScale, face)
        }
        if (focused) Canvas(Modifier.matchParentSize().clearAndSetSemantics { }) {
            drawCutPlate(VoiceInk.text, cut = 5.dp.toPx(), inset = 1.dp.toPx(), stroke = 2.dp.toPx())
        }
    }
}

@Composable
private fun GlyphMuteFace(
    name: String, speaker: Boolean, muted: Boolean, color: Color,
    status: String, pressed: Boolean, heightScale: Float, modifier: Modifier,
) {
    val statusFits = LocalDensity.current.fontScale <= 1.3f
    Column(modifier.drawBehind {
        if (pressed) drawCutPlate(color.copy(alpha = .10f), cut = 5.dp.toPx())
    }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        ChunkyChannelGlyph(speaker, muted, color, VoiceInk.surface,
            Modifier.size((57f * heightScale).coerceIn(34f, 76f).dp))
        Spacer(Modifier.height((10f * heightScale).dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            ControlText(name, color, scaledType(13, heightScale, 11, 16))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ChannelStateMark(!muted, color, Modifier.size(8.dp))
                if (statusFits) {
                    Spacer(Modifier.width(5.dp))
                    ControlText(status, VoiceInk.muted, 11)
                }
            }
        }
    }
}

@Composable
private fun RockerMuteFace(
    name: String, speaker: Boolean, muted: Boolean, color: Color,
    status: String, pressed: Boolean, heightScale: Float, modifier: Modifier,
    light: State<PreviewButtonLight>?, lightEnabled: Boolean,
) {
    val sink = if (pressed) 2.dp else 0.dp
    val statusFits = LocalDensity.current.fontScale <= 1.3f
    Column(modifier.drawBehind {
        val edge = 5.dp.toPx()
        val seam = size.height * if (muted) .65f else .72f
        val top = (if (muted) 9.dp else 4.dp).toPx() + sink.toPx()
        drawCutPlate(VoiceInk.line, cut = 10.dp.toPx())
        drawCutPlate(VoiceInk.ground, cut = 7.dp.toPx(), inset = 2.dp.toPx())
        val upperFace = Path().apply {
            moveTo(edge + 3.dp.toPx(), top)
            lineTo(size.width - edge - 3.dp.toPx(), top)
            lineTo(size.width - edge, top + 4.dp.toPx())
            lineTo(size.width - edge - 3.dp.toPx(), seam)
            lineTo(edge + 3.dp.toPx(), seam)
            lineTo(edge, top + 4.dp.toPx()); close()
        }
        drawPath(upperFace, if (muted) VoiceInk.surface else color.copy(alpha = .12f))
        drawPreviewButtonLight(upperFace, light, lightEnabled, capture = !speaker, ink = color)
        drawPath(Path().apply {
            moveTo(edge + 3.dp.toPx(), seam + 2.dp.toPx())
            lineTo(size.width - edge - 3.dp.toPx(), seam + 2.dp.toPx())
            lineTo(size.width - edge, size.height - edge - if (muted) 4.dp.toPx() else 0f)
            lineTo(edge, size.height - edge - if (muted) 4.dp.toPx() else 0f); close()
        }, if (muted) VoiceInk.line else VoiceInk.surface)
        drawLine(if (muted) VoiceInk.line else color.copy(alpha = .7f),
            Offset(edge + 6.dp.toPx(), top), Offset(size.width - edge - 6.dp.toPx(), top), 2.dp.toPx())
    }.padding(start = 18.dp, top = (18f * heightScale).coerceIn(10f, 28f).dp + sink,
        end = 18.dp, bottom = (14f * heightScale).coerceIn(8f, 22f).dp - sink),
        verticalArrangement = Arrangement.SpaceBetween) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            ChunkyChannelGlyph(speaker, muted, color,
                if (muted) VoiceInk.surface else color.copy(alpha = .12f).over(VoiceInk.ground),
                Modifier.size((46f * heightScale).coerceIn(30f, 72f).dp))
            BinaryDetent(!muted, color, Modifier.width(12.dp).height((38f * heightScale).coerceIn(24f, 48f).dp))
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            ControlText(name, color, scaledType(14, heightScale, 12, 18))
            if (statusFits) ControlText(status, if (muted) VoiceInk.text else VoiceInk.muted, 11)
        }
    }
}

@Composable
private fun KeycapMuteFace(
    name: String, speaker: Boolean, muted: Boolean, color: Color, pressed: Boolean,
    heightScale: Float, modifier: Modifier,
    light: State<PreviewButtonLight>?, lightEnabled: Boolean,
) {
    val depression = if (pressed) 4.dp else 0.dp
    val largeType = LocalDensity.current.fontScale > 1.3f
    Column(modifier.drawBehind {
        drawKeycap(VoiceInk.surface, if (muted) VoiceInk.line else color.copy(alpha = .48f), depression.toPx(),
            light, lightEnabled, capture = !speaker, lightInk = color)
    }.padding(start = 17.dp, top = (12f * heightScale).coerceIn(7f, 18f).dp + depression,
        end = 17.dp, bottom = (18f * heightScale).coerceIn(11f, 24f).dp - depression),
        verticalArrangement = Arrangement.SpaceBetween) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically) {
            ControlText(if (speaker) "RX" else "TX", color,
                scaledType(if (largeType) 22 else 29, heightScale, 18, if (largeType) 32 else 39), bold = true)
            ChannelStateMark(!muted, color, Modifier.size(10.dp))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Bottom) {
            ControlText(name, VoiceInk.muted, 11)
            ChunkyChannelGlyph(speaker, muted, color, VoiceInk.surface,
                Modifier.size(((if (largeType) 32f else 36f) * heightScale).coerceIn(24f, 58f).dp))
        }
    }
}

@Composable
internal fun PreviewHoldControl(
    ui: CallUi,
    style: String,
    onHold: () -> Unit,
    onRelease: () -> Unit,
    modifier: Modifier = Modifier,
    light: State<PreviewButtonLight>? = null,
) {
    val latestUi by rememberUpdatedState(ui)
    val latestHold by rememberUpdatedState(onHold)
    val latestRelease by rememberUpdatedState(onRelease)
    var ownsHold by remember { mutableStateOf(false) }
    var hasOwnedHold by remember { mutableStateOf(false) }
    val releaseOwned by rememberUpdatedState({
        if (ownsHold) {
            ownsHold = false
            latestRelease()
        }
    })
    DisposableEffect(style) {
        onDispose {
            if (ownsHold) releaseOwned() else if (!hasOwnedHold && latestUi.holding) latestRelease()
        }
    }
    LaunchedEffect(ui.canHold) { if (!ui.canHold) releaseOwned() }
    val live = ui.holding && ui.micOpen
    val ink = if (ui.canHold || ui.holding) VoiceInk.you else VoiceInk.muted
    val surface = if (live) VoiceInk.you.copy(alpha = .08f).over(VoiceInk.surface) else VoiceInk.surface
    Box(modifier.pointerInput(style) {
        awaitEachGesture {
            val down = awaitFirstDown()
            down.consume()
            if (latestUi.canHold && !ownsHold) {
                hasOwnedHold = true
                ownsHold = true
                try {
                    latestHold()
                    while (true) {
                        val event = awaitPointerEvent()
                        val pointer = event.changes.firstOrNull { it.id == down.id }
                        if (!latestUi.canHold || pointer == null || !pointer.pressed || pointer.isConsumed ||
                            pointer.isOutOfBounds(size, extendedTouchPadding) ||
                            event.changes.any { it.id != down.id && it.pressed }) break
                        pointer.consume()
                    }
                } finally { releaseOwned() }
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
                        if (ownsHold) releaseOwned() else latestRelease()
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
        when (style) {
            "trigger" -> TriggerHoldFace(ui, ink, surface, face, light)
            "rocker" -> RockerHoldFace(ui, ink, surface, face, light)
            "keycap" -> KeycapHoldFace(ui, ink, surface, face)
            else -> BeamHoldFace(ui, ink, surface, face)
        }
    }
}

@Composable
private fun BeamHoldFace(ui: CallUi, ink: Color, surface: Color, modifier: Modifier) {
    val showPressGlyph = LocalDensity.current.fontScale <= 1.2f
    val microphoneLive = microphoneIsLive(ui)
    BoxWithConstraints(modifier) {
        val short = maxHeight < 100.dp
        Row(Modifier.fillMaxSize().drawBehind {
            drawCutPlate(surface, cut = 5.dp.toPx())
            drawCutPlate(if (ui.canHold || ui.holding) ink.copy(alpha = .65f) else VoiceInk.line,
                cut = 5.dp.toPx(), inset = .75.dp.toPx(), stroke = 1.5.dp.toPx())
            val rail = if (ui.holding) 6.dp.toPx() else 3.dp.toPx()
            drawRect(ink, Offset(7.dp.toPx(), 12.dp.toPx()), Size(rail, size.height - 24.dp.toPx()))
        }.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (showPressGlyph) {
                PressGlyph(ink, ui.holding, Modifier.size(34.dp))
                Spacer(Modifier.width(12.dp))
            }
            Column(Modifier.weight(1f)) {
                ControlText(when {
                    microphoneLive -> "Live now"
                    ui.holding -> "Opening microphone"
                    ui.canHold -> "Push to talk"
                    else -> "Unavailable"
                }, ink, when {
                    ui.holding && !microphoneLive -> 16
                    !ui.canHold && !showPressGlyph -> 17
                    else -> 19
                }, maxLines = 2)
                if (microphoneLive || (!ui.canHold && !ui.holding)) {
                    Spacer(Modifier.height(7.dp))
                    ControlText(if (microphoneLive) {
                        if (ui.holding) "release to mute" else "microphone open"
                    } else holdUnavailableReason(ui, concise = short), VoiceInk.muted, 11, maxLines = 2)
                }
            }
        }
    }
}

@Composable
private fun TriggerHoldFace(
    ui: CallUi, ink: Color, surface: Color, modifier: Modifier, light: State<PreviewButtonLight>?,
) {
    val largeType = LocalDensity.current.fontScale > 1.3f
    val microphoneLive = microphoneIsLive(ui)
    BoxWithConstraints(modifier) {
        val heightScale = (maxHeight.value / 116f).coerceIn(.6f, 1.6f)
        val liveTypeMaximum = if (maxWidth < 300.dp) 24 else 28
        val concise = largeType || maxHeight < 100.dp
        val restingDepth = (6f * heightScale).coerceIn(4f, 10f).dp
        val bottomPadding = (4f * heightScale).coerceIn(2f, 6f).dp
        val inset = (15f * heightScale).coerceIn(10f, 22f).dp
        Row(Modifier.fillMaxSize().drawBehind {
            val cut = (20f * heightScale).coerceIn(14f, 28f).dp.toPx()
            val bottom = size.height - if (ui.holding) 2.dp.toPx() else restingDepth.toPx()
            drawCutPlate(VoiceInk.line, cut = cut)
            val face = Path().apply {
                moveTo(7.dp.toPx(), 0f); lineTo(size.width - cut, 0f)
                lineTo(size.width, cut); lineTo(size.width - 6.dp.toPx(), bottom - cut)
                lineTo(size.width - cut - 6.dp.toPx(), bottom); lineTo(7.dp.toPx(), bottom)
                lineTo(0f, bottom - 7.dp.toPx()); lineTo(0f, 7.dp.toPx()); close()
            }
            drawPath(face, surface)
            drawPreviewButtonLight(face, light, ui.connected && !ui.controlsPending && ui.holding && ui.micOpen,
                capture = true, ink = VoiceInk.you)
            if (ui.holding && ui.micOpen) drawPath(face, ink.copy(alpha = .65f), style = Stroke(1.5.dp.toPx()))
            drawLine(ink, Offset(5.dp.toPx(), inset.toPx()),
                Offset(5.dp.toPx(), bottom - inset.toPx()), 4.dp.toPx())
            repeat(if (largeType) 1 else 3) { index ->
                val x = (22 + index * 8).dp.toPx()
                drawLine(ink.copy(alpha = if (ui.canHold || ui.holding) .45f else .3f),
                    Offset(x, size.height * .35f), Offset(x - 3.dp.toPx(), size.height * .66f),
                    3.dp.toPx(), StrokeCap.Square)
            }
        }.padding(start = if (largeType) 48.dp else 68.dp, end = 23.dp,
            bottom = if (ui.holding) 0.dp else bottomPadding),
            verticalAlignment = Alignment.CenterVertically) {
            Column {
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

@Composable
private fun RockerHoldFace(
    ui: CallUi, ink: Color, surface: Color, modifier: Modifier, light: State<PreviewButtonLight>?,
) {
    val largeType = LocalDensity.current.fontScale > 1.3f
    val live = ui.holding && ui.micOpen
    val microphoneLive = microphoneIsLive(ui)
    BoxWithConstraints(modifier) {
        val heightScale = (maxHeight.value / 116f).coerceIn(.6f, 1.6f)
        val liveTypeMaximum = if (maxWidth < 300.dp) 24 else 28
        val compactFace = largeType || maxWidth < 300.dp
        val concise = compactFace || maxHeight < 100.dp
        val shallow = (4f * heightScale).coerceIn(3f, 6f).dp
        val deep = (7f * heightScale).coerceIn(5f, 10f).dp
        val upperInset = if (ui.holding) deep else shallow
        val lowerInset = if (ui.holding) shallow else deep
        Row(Modifier.fillMaxSize().drawBehind {
            val cut = (12f * heightScale).coerceIn(8f, 16f).dp.toPx()
            val top = upperInset.toPx()
            val bottom = size.height - lowerInset.toPx()
            val upperSide = if (ui.holding) 9.dp.toPx() else 6.dp.toPx()
            val lowerSide = if (ui.holding) 6.dp.toPx() else 9.dp.toPx()
            val corner = (6f * heightScale).coerceIn(4f, 9f).dp.toPx()
            drawCutPlate(VoiceInk.line, cut = cut)
            drawCutPlate(VoiceInk.ground, cut = cut - 2.dp.toPx(), inset = 2.dp.toPx())
            val pivot = size.height / 2f
            drawLine(VoiceInk.muted.copy(alpha = .45f), Offset(3.dp.toPx(), pivot),
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
            }, VoiceInk.line)
            drawPath(face, surface)
            drawPreviewButtonLight(face, light, ui.connected && !ui.controlsPending && live,
                capture = true, ink = VoiceInk.you)
            drawPath(face, VoiceInk.line, style = Stroke(1.dp.toPx()))
            // The face rocks on pressure; illumination follows confirmed capture, never the press alone.
            val lip = when {
                live -> ink.copy(alpha = .65f)
                ui.canHold && !ui.holding -> ink.copy(alpha = .24f)
                else -> VoiceInk.line
            }
            val lipY = if (ui.holding) bottom else top
            val lipInset = (if (ui.holding) lowerSide else upperSide) + corner + 4.dp.toPx()
            drawLine(lip, Offset(lipInset, lipY), Offset(size.width - lipInset, lipY), 1.5.dp.toPx())
        }.padding(start = if (compactFace) 20.dp else 24.dp, top = upperInset,
            end = if (compactFace) 20.dp else 24.dp, bottom = lowerInset),
            verticalAlignment = Alignment.CenterVertically) {
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

@Composable
private fun KeycapHoldFace(ui: CallUi, ink: Color, surface: Color, modifier: Modifier) {
    val depression = if (ui.holding) 5.dp else 0.dp
    val largeType = LocalDensity.current.fontScale > 1.3f
    val microphoneLive = microphoneIsLive(ui)
    BoxWithConstraints(modifier) {
        val heightScale = (maxHeight.value / 116f).coerceIn(.6f, 1.6f)
        val liveTypeMaximum = if (maxWidth < 300.dp) 24 else 28
        Row(Modifier.fillMaxSize().drawBehind {
            drawKeycap(surface, if (ui.canHold || ui.holding) ink.copy(alpha = .6f) else VoiceInk.line, depression.toPx())
        }.padding(start = 24.dp, top = depression, end = 24.dp, bottom = 8.dp - depression),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                ControlText(when {
                    microphoneLive -> if (ui.holding) "release to mute" else "microphone open"
                    ui.holding -> "opening"
                    ui.canHold -> "push to"
                    else -> "unavailable"
                }, ink, scaledType(11, heightScale, 10, 14))
                ControlText(when {
                    microphoneLive -> "Live now"
                    ui.holding -> "mic"
                    ui.canHold -> "talk"
                    else -> "wait"
                }, ink, if (microphoneLive) scaledType(24, heightScale, 19, liveTypeMaximum)
                    else scaledType(32, heightScale, 23, 42), bold = true)
            }
            if (!largeType) PressGlyph(ink, ui.holding, Modifier.size((36f * heightScale).coerceIn(26f, 52f).dp))
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
private fun ControlText(text: String, color: Color, size: Int, bold: Boolean = false, maxLines: Int = 1) {
    Text(text, color = color, fontFamily = VoiceInk.type, fontSize = size.sp,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
        letterSpacing = 0.sp, lineHeight = (size * 1.15f).sp, maxLines = maxLines)
}

@Composable
private fun ChannelStateMark(on: Boolean, ink: Color, modifier: Modifier) {
    Canvas(modifier) {
        if (on) drawRect(ink)
        else drawRect(ink, style = Stroke(1.5.dp.toPx()))
    }
}

@Composable
private fun BinaryDetent(on: Boolean, ink: Color, modifier: Modifier) {
    Canvas(modifier) {
        drawLine(if (on) ink else VoiceInk.line, Offset(size.width / 2, 2.dp.toPx()),
            Offset(size.width / 2, 12.dp.toPx()), 3.dp.toPx())
        drawCircle(if (on) VoiceInk.line else ink, radius = 4.dp.toPx(),
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

@Composable
private fun PressGlyph(ink: Color, pressed: Boolean, modifier: Modifier) {
    Canvas(modifier) {
        val unit = size.minDimension / 48f
        scale(unit, unit, Offset.Zero) {
            val drop = if (pressed) 5f else 0f
            drawRect(ink, Offset(20f, 3f + drop), Size(8f, 20f))
            drawPath(Path().apply {
                moveTo(10f, 20f + drop); lineTo(38f, 20f + drop)
                lineTo(24f, 34f + drop); close()
            }, ink)
            drawRect(ink, Offset(7f, 42f), Size(34f, 5f))
        }
    }
}

private fun DrawScope.drawKeycap(
    face: Color, edge: Color, depression: Float,
    light: State<PreviewButtonLight>? = null, lightEnabled: Boolean = false,
    capture: Boolean = true, lightInk: Color = VoiceInk.you,
) {
    drawCutPlate(VoiceInk.line, cut = 7.dp.toPx(), top = 7.dp.toPx())
    val facePath = drawCutPlate(face, cut = 7.dp.toPx(), top = depression, bottom = 8.dp.toPx() - depression)
    drawPreviewButtonLight(facePath, light, lightEnabled, capture, lightInk)
    drawCutPlate(edge, cut = 7.dp.toPx(), inset = .75.dp.toPx(), top = depression,
        bottom = 8.dp.toPx() - depression, stroke = 1.5.dp.toPx())
    drawLine(edge.copy(alpha = .6f), Offset(13.dp.toPx(), size.height - 4.dp.toPx()),
        Offset(size.width - 13.dp.toPx(), size.height - 4.dp.toPx()), 1.dp.toPx())
}

private fun DrawScope.drawCutPlate(
    color: Color, cut: Float, inset: Float = 0f, top: Float = 0f, bottom: Float = 0f, stroke: Float = 0f,
): Path {
    val left = inset
    val right = size.width - inset
    val upper = top + inset
    val lower = size.height - bottom - inset
    val corner = cut.coerceAtMost((right - left) / 2).coerceAtMost((lower - upper) / 2)
    val path = Path().apply {
        moveTo(left + corner, upper); lineTo(right - corner, upper)
        lineTo(right, upper + corner); lineTo(right, lower - corner)
        lineTo(right - corner, lower); lineTo(left + corner, lower)
        lineTo(left, lower - corner); lineTo(left, upper + corner); close()
    }
    if (stroke > 0f) drawPath(path, color, style = Stroke(stroke)) else drawPath(path, color)
    return path
}

private fun Color.over(ground: Color): Color = Color(
    red * alpha + ground.red * (1 - alpha),
    green * alpha + ground.green * (1 - alpha),
    blue * alpha + ground.blue * (1 - alpha),
)
