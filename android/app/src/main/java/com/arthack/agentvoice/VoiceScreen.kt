package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.isOutOfBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal object VoiceInk {
    val type = FontFamily(Font(R.font.ibm_plex_mono_regular))
    val ground = Color(0xFF050607)
    val surface = Color(0xFF101311)
    val text = Color(0xFFF0F2E9)
    val muted = Color(0xFF90988F)
    val line = Color(0xFF343B33)
    val you = Color(0xFFD4FF72)
    val agent = Color(0xFFBBAAFF)
}

@Composable
internal fun VoiceTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(primary = VoiceInk.you, background = VoiceInk.ground,
        surface = VoiceInk.surface, onBackground = VoiceInk.text, onSurface = VoiceInk.text), content = content)
}

@Composable
internal fun VoiceScreen(
    ui: CallUi, hasGrant: Boolean, importing: Boolean = false, setupMessage: String? = null,
    start: () -> Unit, stop: () -> Unit, importGrant: () -> Unit,
    mute: (String) -> Unit, hold: () -> Unit, release: () -> Unit,
    preview: Boolean = false,
    personaPlacement: PersonaPlacement = PersonaPlacement(),
) {
    val currentRelease by rememberUpdatedState(release)
    DisposableEffect(Unit) { onDispose { currentRelease() } }
    BoxWithConstraints(Modifier.fillMaxSize().background(VoiceInk.ground).safeDrawingPadding()) {
        val compact = maxHeight < 660.dp
        val shallow = maxHeight < 500.dp
        val side = if (maxWidth < 360.dp) 22.dp else 30.dp
        Column(Modifier.fillMaxSize().then(if (shallow) Modifier.verticalScroll(rememberScrollState()) else Modifier)) {
            Box(Modifier.fillMaxWidth().then(if (shallow) Modifier.height(174.dp) else Modifier.weight(1f))) {
                PersonaHalo(ui, Modifier.fillMaxSize(), personaPlacement)
                // Foreground siblings win both drawing and hit testing over the scaled native view.
                Row(Modifier.fillMaxWidth().padding(horizontal = side).height(64.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ConnectionSignal(ui, hasGrant)
                            Spacer(Modifier.width(10.dp))
                            Label(if (preview) "agentvoice / preview" else "agentvoice", color = VoiceInk.muted, size = if (preview) 12 else 15)
                        }
                        if (ui.running && !ui.connected) {
                            Spacer(Modifier.height(3.dp))
                            Label(ui.phase, Modifier.padding(start = 18.dp).clearAndSetSemantics { }, color = VoiceInk.muted, size = 10)
                        }
                    }
                    if (ui.running) {
                        Box(Modifier.size(48.dp).clickable(onClickLabel = "End call", onClick = stop)
                            .semantics { contentDescription = "End call" }.testTag("end-call"), contentAlignment = Alignment.Center) {
                            Canvas(Modifier.size(18.dp)) {
                                drawLine(VoiceInk.muted, Offset(2.dp.toPx(), 2.dp.toPx()), Offset(size.width - 2.dp.toPx(), size.height - 2.dp.toPx()), 1.5.dp.toPx())
                                drawLine(VoiceInk.muted, Offset(size.width - 2.dp.toPx(), 2.dp.toPx()), Offset(2.dp.toPx(), size.height - 2.dp.toPx()), 1.5.dp.toPx())
                            }
                        }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = side)) {
                val message = setupMessage ?: ui.message
                if (message != null) {
                    Text(message, color = VoiceInk.text, fontFamily = VoiceInk.type,
                        fontSize = 12.sp, lineHeight = 19.sp, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)
                            .semantics { liveRegion = LiveRegionMode.Polite })
                }
                Row(Modifier.fillMaxWidth().height(if (compact) 106.dp else 126.dp)) {
                    Channel("YOU", ui.micMuted, ui.micOpen, ui.connected && !ui.controlsPending,
                        VoiceInk.you, false, Modifier.weight(1f)) { mute("mic") }
                    Spacer(Modifier.width(20.dp))
                    Channel("AGENT", ui.speakerMuted, ui.speakerOpen, ui.connected && !ui.controlsPending,
                        VoiceInk.agent, true, Modifier.weight(1f)) { mute("speaker") }
                }
                Spacer(Modifier.height(if (compact) 20.dp else 32.dp))
                if (ui.running) {
                    HoldSurface(ui, hold, release, Modifier.fillMaxWidth().height(if (compact) 104.dp else 120.dp))
                } else {
                    val action = if (hasGrant) "Start voice" else "Import device grant"
                    Box(Modifier.fillMaxWidth().height(if (compact) 104.dp else 120.dp)
                        .background(VoiceInk.you, RoundedCornerShape(3.dp))
                        .clickable(enabled = !importing, role = Role.Button,
                            onClick = if (hasGrant) start else importGrant)
                        .testTag("start-voice"), contentAlignment = Alignment.Center) {
                        Label(if (importing) "Importing…" else action, color = VoiceInk.ground, size = 19)
                    }
                }
                Box(Modifier.fillMaxWidth().height(58.dp), contentAlignment = Alignment.Center) {
                    when {
                        ui.running && ui.connected && !ui.micMuted -> Label("Mute YOU to use push to talk", color = VoiceInk.muted, size = 11)
                        !ui.running && hasGrant -> Box(Modifier.fillMaxHeight()
                            .clickable(enabled = !importing, role = Role.Button, onClick = importGrant), contentAlignment = Alignment.Center) {
                            Label("Replace device grant", color = VoiceInk.muted, size = 11)
                        }
                        !ui.running -> Label("Choose the private file from your server", color = VoiceInk.muted, size = 10)
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionSignal(ui: CallUi, hasGrant: Boolean) {
    Canvas(Modifier.size(8.dp).semantics {
        contentDescription = "Connection"
        stateDescription = if (!hasGrant) "Not connected" else ui.phase
        liveRegion = LiveRegionMode.Polite
    }.testTag("connection-status")) {
        if (ui.connected) drawCircle(VoiceInk.you)
        else drawCircle(VoiceInk.muted, radius = size.minDimension / 2 - .75.dp.toPx(), style = Stroke(1.5.dp.toPx()))
    }
}

@Composable
private fun Label(text: String, modifier: Modifier = Modifier, color: Color = VoiceInk.text, size: Int = 14) {
    Text(text, modifier, color = color, fontSize = size.sp, fontFamily = VoiceInk.type,
        fontWeight = FontWeight.Normal, letterSpacing = .1.sp)
}

@Composable
private fun Channel(name: String, muted: Boolean, open: Boolean, enabled: Boolean, ink: Color,
    speaker: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val color = if (enabled && (!muted || open)) ink else VoiceInk.muted
    Column(modifier.fillMaxHeight().clickable(enabled = enabled, role = Role.Switch,
        onClickLabel = if (muted) "Unmute $name" else "Mute $name", onClick = onClick)
        .semantics(mergeDescendants = true) {
            contentDescription = if (speaker) "AGENT speaker" else "YOU microphone"
            toggleableState = if (muted) androidx.compose.ui.state.ToggleableState.Off else androidx.compose.ui.state.ToggleableState.On
            stateDescription = if (muted && open) "Talking; muted on release" else if (muted) "Muted" else "On"
        }.testTag(if (speaker) "speaker-mute" else "mic-mute"),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        ChannelGlyph(speaker, muted && !open, color, Modifier.size(25.dp))
        Spacer(Modifier.height(14.dp))
        Label(name, color = color, size = 20)
        Spacer(Modifier.height(5.dp))
        Label(if (!enabled && !open) "—" else if (muted && open) "Talking" else if (muted) "Muted" else "On", color = VoiceInk.muted, size = 11)
    }
}

@Composable
private fun ChannelGlyph(speaker: Boolean, muted: Boolean, color: Color, modifier: Modifier) {
    Canvas(modifier) {
        val scale = size.width / 24f
        fun point(x: Float, y: Float) = Offset(x * scale, y * scale)
        val stroke = 1.25f * scale
        if (speaker) {
            val body = Path().apply {
                moveTo(3 * scale, 9 * scale); lineTo(7 * scale, 9 * scale)
                lineTo(12 * scale, 5 * scale); lineTo(12 * scale, 19 * scale)
                lineTo(7 * scale, 15 * scale); lineTo(3 * scale, 15 * scale); close()
            }
            drawPath(body, color, style = Stroke(stroke, join = StrokeJoin.Round))
            if (!muted) {
                drawArc(color, -50f, 100f, false, point(10f, 7f), androidx.compose.ui.geometry.Size(9 * scale, 10 * scale), style = Stroke(stroke))
                drawArc(color, -50f, 100f, false, point(8f, 3f), androidx.compose.ui.geometry.Size(15 * scale, 18 * scale), style = Stroke(stroke))
            }
        } else {
            drawRoundRect(color, point(9f, 3f), androidx.compose.ui.geometry.Size(6 * scale, 12 * scale),
                androidx.compose.ui.geometry.CornerRadius(3 * scale), style = Stroke(stroke))
            drawArc(color, 0f, 180f, false, point(6f, 6f), androidx.compose.ui.geometry.Size(12 * scale, 12 * scale), style = Stroke(stroke))
            drawLine(color, point(12f, 18f), point(12f, 22f), stroke)
            drawLine(color, point(8f, 22f), point(16f, 22f), stroke)
        }
        if (muted) {
            drawLine(VoiceInk.ground, point(3f, 3f), point(22f, 22f), stroke * 3)
            drawLine(color, point(3f, 3f), point(22f, 22f), stroke)
        }
    }
}

@Composable
private fun HoldSurface(ui: CallUi, hold: () -> Unit, release: () -> Unit, modifier: Modifier) {
    val latestHold by rememberUpdatedState(hold)
    val latestRelease by rememberUpdatedState(release)
    val latestCanHold by rememberUpdatedState(ui.canHold)
    val glowing = ui.holding && ui.micOpen
    val background = if (glowing) VoiceInk.you else VoiceInk.surface
    val color = if (glowing) VoiceInk.ground else if (ui.canHold) VoiceInk.you else VoiceInk.muted
    Box(modifier.background(background, RoundedCornerShape(3.dp))
        .border(1.dp, if (ui.canHold) VoiceInk.you.copy(alpha = .5f) else VoiceInk.line, RoundedCornerShape(3.dp))
        .pointerInput(Unit) {
            awaitEachGesture {
                val down = awaitFirstDown()
                down.consume()
                if (latestCanHold) {
                    latestHold()
                    try {
                        while (true) {
                            val event = awaitPointerEvent()
                            val pointer = event.changes.firstOrNull { it.id == down.id }
                            if (pointer == null || !pointer.pressed || pointer.isConsumed ||
                                pointer.isOutOfBounds(size, extendedTouchPadding) ||
                                event.changes.any { it.id != down.id && it.pressed }) break
                            pointer.consume()
                        }
                    } finally { latestRelease() }
                }
            }
        }.semantics {
            role = Role.Button
            contentDescription = "Push to talk"
            stateDescription = if (ui.holding) "Release to mute" else if (ui.canHold) "Ready" else "Unavailable"
            if (!ui.canHold) disabled()
            // TalkBack exposes explicit start/stop actions; no timed fake press or automatic release.
            customActions = if (!ui.canHold) emptyList() else listOf(
                CustomAccessibilityAction(if (ui.holding) "Stop talking" else "Start talking") {
                    if (ui.holding) latestRelease() else latestHold()
                    true
                })
        }.testTag("hold-to-talk"), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Label(when { glowing -> "Release to mute"; ui.holding -> "Opening microphone"; else -> "Push to talk" }, color = color, size = 18)
            if (ui.holding) {
                Spacer(Modifier.height(8.dp))
                Label(if (glowing) "YOU are live" else "Waiting for confirmation", color = color, size = 10)
            }
        }
    }
}
