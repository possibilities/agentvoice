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
        PreviewMuteControls(ui, onMute, Modifier.fillMaxWidth().height(geometry.muteHeightDp.dp), light)
        Canvas(Modifier.fillMaxWidth().height(PREVIEW_CONTROL_CONDUIT_DP.dp).clearAndSetSemantics { }) {
            // Hold gates capture only; the conduit belongs to the microphone side of the deck.
            val x = (size.width - 10.dp.toPx()) / 4f
            val ink = if (ui.canHold || ui.holding) VoiceInk.you else VoiceInk.line
            drawLine(ink, Offset(x, 0f), Offset(x, size.height), 3.dp.toPx())
            drawLine(ink, Offset(x - 8.dp.toPx(), size.height - 1.dp.toPx()),
                Offset(x + 8.dp.toPx(), size.height - 1.dp.toPx()), 2.dp.toPx())
        }
        key(geometry) {
            PreviewHoldControl(ui, { latestHold() }, { latestRelease() },
                Modifier.fillMaxWidth().height(geometry.holdHeightDp.dp), light)
        }
    }
}

@Composable
internal fun PreviewMuteControls(
    ui: CallUi,
    onMute: (String) -> Unit,
    modifier: Modifier = Modifier,
    light: State<PreviewButtonLight>? = null,
) {
    BoxWithConstraints(modifier) {
        val heightScale = (maxHeight.value / 130f).coerceIn(.6f, 1.6f)
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PreviewMuteButton("YOU", "mic", ui.micMuted, ui.micOpen, ui.connected && !ui.controlsPending,
                VoiceInk.you, heightScale, light, onMute, Modifier.weight(1f).fillMaxHeight())
            PreviewMuteButton("AGENT", "speaker", ui.speakerMuted, ui.speakerOpen, ui.connected && !ui.controlsPending,
                VoiceInk.agent, heightScale, light, onMute, Modifier.weight(1f).fillMaxHeight())
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
        RockerMuteFace(name, target == "speaker", muted, color, status, pressed, heightScale,
            face, light, enabled && !muted && open)
        if (focused) Canvas(Modifier.matchParentSize().clearAndSetSemantics { }) {
            drawCutPlate(VoiceInk.text, cut = 5.dp.toPx(), inset = 1.dp.toPx(), stroke = 2.dp.toPx())
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
internal fun PreviewHoldControl(
    ui: CallUi,
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
    DisposableEffect(Unit) {
        onDispose {
            if (ownsHold) releaseOwned() else if (!hasOwnedHold && latestUi.holding) latestRelease()
        }
    }
    LaunchedEffect(ui.canHold) { if (!ui.canHold) releaseOwned() }
    val live = ui.holding && ui.micOpen
    val ink = if (ui.canHold || ui.holding) VoiceInk.you else VoiceInk.muted
    val surface = if (live) VoiceInk.you.copy(alpha = .08f).over(VoiceInk.surface) else VoiceInk.surface
    Box(modifier.pointerInput(Unit) {
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
        RockerHoldFace(ui, ink, surface, face, light)
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
