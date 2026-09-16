package com.arthack.agentvoice

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.net.URI

/** Shared with Studio. Profile metadata contains no credential or enrollment secret. */
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
    profiles: List<ServerProfile>? = null,
    attemptedProfileId: String? = null,
    selectedProfileId: String? = null,
    busyProfileId: String? = null,
    onConnectProfile: ((String) -> Unit)? = null,
    onForgetProfile: ((String) -> Unit)? = null,
    profileErrorId: String? = null,
    accessMessage: String? = null,
    onRetryAccess: (() -> Unit)? = null,
) {
    val retainedCall = profiles?.isEmpty() == true && ui.running
    val saved = if (retainedCall) listOf(
        ServerProfile(attemptedProfileId ?: "active", "Current call", "", ServerProfileState.READY),
    ) else profiles ?: if (paired || pairingPending) listOf(
        ServerProfile("preview", "Server 1", "", if (pairingPending) ServerProfileState.PENDING else ServerProfileState.READY),
    ) else emptyList()
    val currentId = attemptedProfileId?.takeIf { id -> saved.any { it.id == id } }
        ?: selectedProfileId ?: saved.firstOrNull()?.id
    val busy = busyProfileId != null
    Column(
        Modifier.fillMaxSize().background(VoiceInk.ground).safeDrawingPadding()
            .verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 28.dp)
            .testTag("connection-screen"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 560.dp).fillMaxWidth()) {
            Text("Connections", color = VoiceInk.text, fontFamily = VoiceInk.type,
                fontSize = 30.sp, lineHeight = 36.sp,
                modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(24.dp))
            if (accessMessage != null) {
                Text(accessMessage, color = VoiceInk.muted, fontFamily = VoiceInk.type,
                    fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.testTag("connection-access-message"))
                onRetryAccess?.let { action ->
                    TextButton(onClick = action, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text("Try opening saved servers again", color = VoiceInk.text, fontFamily = VoiceInk.type)
                    }
                }
                Spacer(Modifier.height(20.dp))
            }
            if (saved.isEmpty()) {
                Text("Scan the code shown by AgentVoice on your desktop.",
                    color = VoiceInk.muted, fontFamily = VoiceInk.type, fontSize = 14.sp, lineHeight = 21.sp)
                Spacer(Modifier.height(20.dp))
                PrimaryConnectionButton("Scan to connect", "connection-scan", onScan)
            } else {
                saved.forEachIndexed { index, profile ->
                    val current = profile.id == currentId
                    val state = when {
                        busyProfileId == profile.id -> "Switching…"
                        profile.state == ServerProfileState.PENDING -> "Pairing not finished"
                        profileErrorId == profile.id -> "Couldn’t open saved access"
                        current && ui.connected -> "Call in progress"
                        current && ui.running -> when (ui.phase) {
                            "Voice unavailable", "Voice stopped" -> ui.phase
                            else -> if (ui.hasReachedLive) "Voice disconnected" else "Connecting…"
                        }
                        current && ui.message != null && !ui.message.startsWith("Call ended") -> "Couldn’t connect"
                        else -> "Ready to connect"
                    }
                    if (index > 0) HorizontalDivider(color = VoiceInk.line, modifier = Modifier.padding(vertical = 18.dp))
                    Column(Modifier.fillMaxWidth().testTag("connection-profile-${profile.id}")) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(profile.name, color = VoiceInk.text, fontFamily = VoiceInk.type,
                                    fontSize = 18.sp, lineHeight = 24.sp)
                                if (profile.endpoint.isNotEmpty()) Text(
                                    runCatching { URI(profile.endpoint).rawAuthority }.getOrNull() ?: profile.endpoint,
                                    color = VoiceInk.muted, fontFamily = VoiceInk.type, fontSize = 13.sp, lineHeight = 19.sp)
                            }
                            if (onForgetProfile != null && !retainedCall && accessMessage == null) {
                                var menuOpen by remember(profile.id) { mutableStateOf(false) }
                                Box {
                                    TextButton(onClick = { menuOpen = true }, enabled = !busy,
                                        modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                                            .testTag("connection-menu-${profile.id}")
                                            .semantics { contentDescription = "Options for ${profile.name}" }) {
                                        Text("•••", color = VoiceInk.muted, fontSize = 16.sp)
                                    }
                                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                        DropdownMenuItem(text = { Text("Forget server") }, onClick = {
                                            menuOpen = false
                                            onForgetProfile(profile.id)
                                        })
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(state, color = if (current && ui.connected) VoiceInk.agent else VoiceInk.muted,
                            fontFamily = VoiceInk.type, fontSize = 13.sp, lineHeight = 19.sp,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                                .testTag(if (current) "connection-status" else "connection-status-${profile.id}"))
                        Spacer(Modifier.height(12.dp))
                        when {
                            profile.state == ServerProfileState.PENDING ->
                                PrimaryConnectionButton("Finish pairing", "connection-finish-pairing", onScan, enabled = !busy && accessMessage == null)
                            current && ui.connected -> {
                                PrimaryConnectionButton("Return to call", "connection-return", onReturnToCall, enabled = !busy)
                                TextButton(onClick = onDisconnect, enabled = !busy, modifier = Modifier.fillMaxWidth()
                                    .heightIn(min = 48.dp).testTag("connection-disconnect")) {
                                    Text("Disconnect", color = Color(0xFFFFC6BE), fontFamily = VoiceInk.type)
                                }
                            }
                            current && ui.running -> {
                                val stopped = ui.hasReachedLive || ui.phase in setOf("Voice unavailable", "Voice stopped")
                                SecondaryConnectionButton(if (stopped) "End attempt" else "Cancel",
                                    if (stopped) "connection-end-attempt" else "connection-cancel", onDisconnect, enabled = !busy)
                            }
                            else -> PrimaryConnectionButton(
                                if (state.startsWith("Couldn’t")) "Try again" else "Connect",
                                if (current) "connection-connect" else "connection-connect-${profile.id}",
                                { onConnectProfile?.invoke(profile.id) ?: onConnect() }, enabled = !busy && accessMessage == null,
                            )
                        }
                        if (state == "Couldn’t connect") {
                            Spacer(Modifier.height(10.dp))
                            Text("Check that AgentVoice and Tailscale are available, then try again.",
                                color = VoiceInk.muted, fontFamily = VoiceInk.type, fontSize = 13.sp, lineHeight = 19.sp)
                        } else if (state == "Couldn’t open saved access") {
                            Spacer(Modifier.height(10.dp))
                            Text("Saved access is kept. Try again, or forget this server and pair again.",
                                color = VoiceInk.muted, fontFamily = VoiceInk.type, fontSize = 13.sp, lineHeight = 19.sp)
                        }
                    }
                }
                Spacer(Modifier.height(24.dp))
                if (accessMessage == null && saved.none { it.state == ServerProfileState.PENDING }) SecondaryConnectionButton("Add server", "connection-scan", onScan, enabled = !busy)
            }
            onCredits?.let {
                Spacer(Modifier.height(16.dp))
                SecondaryConnectionButton("Credits", "connection-credits", it)
            }
        }
    }
}

@Composable
private fun PrimaryConnectionButton(label: String, tag: String, action: () -> Unit, enabled: Boolean = true) {
    Button(
        onClick = action, enabled = enabled,
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
    enabled: Boolean = true,
) {
    val color = if (destructive) Color(0xFFFFC6BE) else VoiceInk.text
    OutlinedButton(
        onClick = action, enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag(tag),
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, if (destructive) Color(0xFF87675F) else VoiceInk.line),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = VoiceInk.ground, contentColor = color),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(label, fontFamily = VoiceInk.type, fontSize = 14.sp, lineHeight = 20.sp, textAlign = TextAlign.Center)
    }
}
