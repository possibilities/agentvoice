package com.arthack.agentvoice

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Presentation for the app root. Enrollment and call ownership stay with the caller. */
@Composable
internal fun ConnectionScreen(
    ui: CallUi,
    paired: Boolean,
    onConnect: () -> Unit,
    onReturnToCall: () -> Unit,
    onDisconnect: () -> Unit,
    onScan: () -> Unit,
    onCredits: (() -> Unit)? = null,
    pairingPending: Boolean = false,
) {
    val state = when {
        pairingPending -> ConnectionRootState.Pending
        !paired -> ConnectionRootState.Unpaired
        ui.connected -> ConnectionRootState.Active
        ui.running && ui.phase == "Voice unavailable" -> ConnectionRootState.VoiceUnavailable
        ui.running && ui.phase == "Voice stopped" -> ConnectionRootState.VoiceStopped
        ui.running -> ConnectionRootState.Connecting
        ui.message != null && !ui.message.startsWith("Call ended") -> ConnectionRootState.Failed
        else -> ConnectionRootState.Disconnected
    }
    val scroll = rememberScrollState()

    BoxWithConstraints(
        Modifier.fillMaxSize().background(VoiceInk.ground).safeDrawingPadding()
            .testTag("connection-screen"),
    ) {
        val landscape = maxWidth > maxHeight && maxWidth >= 560.dp
        val layout = if (landscape) {
            Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 24.dp)
        } else {
            Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp)
        }
        if (landscape) {
            Row(
                layout.verticalScroll(scroll),
                horizontalArrangement = Arrangement.spacedBy(32.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ConnectionHeader(state, Modifier.weight(.82f))
                ConnectionCard(
                    state, onConnect, onReturnToCall, onDisconnect, onScan, onCredits,
                    Modifier.weight(1.18f),
                )
            }
        } else {
            Column(
                layout.verticalScroll(scroll),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(28.dp),
            ) {
                ConnectionHeader(state, Modifier.fillMaxWidth().widthIn(max = 520.dp))
                ConnectionCard(
                    state, onConnect, onReturnToCall, onDisconnect, onScan, onCredits,
                    Modifier.fillMaxWidth().widthIn(max = 520.dp),
                )
            }
        }
    }
}

private enum class ConnectionRootState {
    Unpaired,
    Pending,
    Disconnected,
    Connecting,
    Failed,
    VoiceUnavailable,
    VoiceStopped,
    Active,
}

@Composable
private fun ConnectionHeader(state: ConnectionRootState, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        DatumLabel("AGENTVOICE")
        Text(
            if (state == ConnectionRootState.Unpaired) "Make a\nconnection." else "Your connection.",
            color = VoiceInk.text,
            fontFamily = VoiceInk.type,
            fontSize = 30.sp,
            lineHeight = 36.sp,
            fontWeight = FontWeight.Normal,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            when (state) {
                ConnectionRootState.Unpaired -> "Scan the code shown by AgentVoice on your desktop."
                ConnectionRootState.Pending -> "Finish pairing this phone with your agent."
                ConnectionRootState.Active -> "Your call is active and ready to return to."
                else -> "Your agent is saved on this phone."
            },
            color = VoiceInk.muted,
            fontFamily = VoiceInk.type,
            fontSize = 13.sp,
            lineHeight = 20.sp,
        )
    }
}

@Composable
private fun ConnectionCard(
    state: ConnectionRootState,
    onConnect: () -> Unit,
    onReturnToCall: () -> Unit,
    onDisconnect: () -> Unit,
    onScan: () -> Unit,
    onCredits: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.testTag("connection-card"),
        color = VoiceInk.surface,
        shape = RoundedCornerShape(7.dp),
        border = BorderStroke(1.dp, VoiceInk.line),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(15.dp)) {
                AgentMark()
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("Your agent", color = VoiceInk.text, fontFamily = VoiceInk.type,
                        fontSize = 18.sp, lineHeight = 24.sp)
                    Text(
                        when (state) {
                            ConnectionRootState.Unpaired -> "Not paired"
                            ConnectionRootState.Pending -> "Pairing not finished"
                            ConnectionRootState.Disconnected -> "Ready to connect"
                            ConnectionRootState.Connecting -> "Connecting…"
                            ConnectionRootState.Failed -> "Couldn’t connect"
                            ConnectionRootState.VoiceUnavailable -> "Voice unavailable"
                            ConnectionRootState.VoiceStopped -> "Voice stopped"
                            ConnectionRootState.Active -> "Call in progress"
                        },
                        color = if (state == ConnectionRootState.Active) VoiceInk.agent else VoiceInk.muted,
                        fontFamily = VoiceInk.type,
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                            .testTag("connection-status"),
                    )
                }
            }

            when (state) {
                ConnectionRootState.Unpaired -> PrimaryConnectionButton("Scan to connect", "connection-scan", onScan)
                ConnectionRootState.Pending -> PrimaryConnectionButton("Finish pairing", "connection-finish-pairing", onScan)
                ConnectionRootState.Disconnected -> PrimaryConnectionButton("Connect", "connection-connect", onConnect)
                ConnectionRootState.Failed -> PrimaryConnectionButton("Try again", "connection-connect", onConnect)
                ConnectionRootState.Connecting -> SecondaryConnectionButton("Cancel", "connection-cancel", onDisconnect)
                ConnectionRootState.VoiceUnavailable,
                ConnectionRootState.VoiceStopped -> SecondaryConnectionButton(
                    "End attempt", "connection-end-attempt", onDisconnect, destructive = true,
                )
                ConnectionRootState.Active -> {
                    PrimaryConnectionButton("Return to call", "connection-return", onReturnToCall)
                    SecondaryConnectionButton("Disconnect", "connection-disconnect", onDisconnect, destructive = true)
                }
            }

            if (state in setOf(
                    ConnectionRootState.Failed,
                    ConnectionRootState.VoiceUnavailable,
                    ConnectionRootState.VoiceStopped,
                )
            ) {
                Text(
                    if (state == ConnectionRootState.Failed)
                        "Check that AgentVoice and Tailscale are available, then try again."
                    else
                        "End this attempt before connecting again.",
                    color = VoiceInk.muted,
                    fontFamily = VoiceInk.type,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                )
            }
            onCredits?.let { credits ->
                SecondaryConnectionButton("Credits", "connection-credits", credits)
            }
        }
    }
}

@Composable
private fun PrimaryConnectionButton(label: String, tag: String, action: () -> Unit) {
    Button(
        onClick = action,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag),
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, VoiceInk.you.copy(alpha = .58f)),
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1B2318), contentColor = VoiceInk.text),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 14.dp),
    ) {
        Text(label, fontFamily = VoiceInk.type, fontSize = 16.sp, lineHeight = 22.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun SecondaryConnectionButton(
    label: String,
    tag: String,
    action: () -> Unit,
    destructive: Boolean = false,
) {
    val color = if (destructive) Color(0xFFFFC6BE) else VoiceInk.text
    OutlinedButton(
        onClick = action,
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag(tag),
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, if (destructive) Color(0xFF87675F) else VoiceInk.line),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = VoiceInk.ground, contentColor = color),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(label, fontFamily = VoiceInk.type, fontSize = 14.sp, lineHeight = 20.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun AgentMark() {
    Canvas(Modifier.size(54.dp)) {
        val center = Offset(size.width / 2f, size.height / 2f)
        val radius = size.minDimension * .42f
        drawCircle(VoiceInk.agent.copy(alpha = .12f), radius)
        drawCircle(VoiceInk.muted, radius, style = androidx.compose.ui.graphics.drawscope.Stroke(1.5.dp.toPx()))
        drawCircle(VoiceInk.agent.copy(alpha = .62f), radius * .72f,
            style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
        drawLine(VoiceInk.line, Offset(center.x - radius * .42f, center.y),
            Offset(center.x + radius * .42f, center.y), 1.dp.toPx())
    }
}

@Composable
private fun DatumLabel(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Canvas(Modifier.width(22.dp).height(1.dp)) { drawLine(VoiceInk.line, Offset.Zero, Offset(size.width, 0f), 1.dp.toPx()) }
        Text(text, color = VoiceInk.muted, fontFamily = VoiceInk.type, fontSize = 11.sp, letterSpacing = 2.sp)
        Canvas(Modifier.width(22.dp).height(1.dp)) { drawLine(VoiceInk.line, Offset.Zero, Offset(size.width, 0f), 1.dp.toPx()) }
    }
}
