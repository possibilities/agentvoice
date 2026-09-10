package com.arthack.agentvoice

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

internal enum class ConnectionScene(val key: String, val title: String, val detail: String, val action: String? = null) {
    Permission("permission", "Scan a connection code", "Allow camera access to connect this phone to your AgentVoice server.", "Allow camera"),
    Denied("denied", "Camera access is off", "Allow camera access in Android settings, then return here to scan your code.", "Open settings"),
    Opening("opening", "Opening camera…", "Point this phone at the connection code on your server."),
    Scanning("scanning", "Scan a connection code", "On your server, run the command below. Then point this phone at the code."),
    Unavailable("unavailable", "Camera unavailable", "Check that no other app is using the camera, then try again.", "Try again"),
    Invalid("invalid", "That isn’t an AgentVoice code", "Use a connection code from your AgentVoice server.", "Scan again"),
    Found("found", "Code found", "Preparing your connection…"),
    Saving("saving", "Securing access…", "Keeping your device access encrypted on this phone."),
    Connecting("connecting", "Connecting…", "Your Persona will be here shortly."),
    Failed("failed", "Couldn’t reach the server", "Check your server and Tailscale connection, then try again.", "Try again");

    companion object {
        fun camera(state: ConnectionCameraState) = when (state) {
            ConnectionCameraState.Permission -> Permission
            ConnectionCameraState.Denied -> Denied
            ConnectionCameraState.Opening -> Opening
            ConnectionCameraState.Scanning -> Scanning
            ConnectionCameraState.Unavailable -> Unavailable
        }
    }
}

/** Presentation only. The owner decides whether camera, enrollment, or rehearsal supplies state. */
@Composable
internal fun ConnectionOverlay(
    scene: ConnectionScene,
    close: () -> Unit,
    action: () -> Unit = {},
    studio: Boolean = false,
    theme: String = "bright",
    personaSide: String = "left",
    camera: @Composable (Modifier) -> Unit = {},
) {
    val palette = PreviewTheme.resolve(theme)
    val ink = palette.surface(VoiceInk.text)
    val accent = palette.surface(VoiceInk.you)
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false,
        dismissOnClickOutside = false, decorFitsSystemWindows = false)) {
        BoxWithConstraints(Modifier.fillMaxSize().background(VoiceInk.ground).safeDrawingPadding()
            .padding(24.dp).testTag("connection-overlay")) {
            val landscape = maxWidth > maxHeight
            val apertureSize = if (landscape) minOf(maxHeight - 64.dp, maxWidth * .48f)
                else minOf(maxWidth, maxHeight * .42f, 420.dp)
            val aperture: @Composable () -> Unit = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(apertureSize.coerceAtLeast(80.dp)).clip(RoundedCornerShape(24.dp))
                    .background(VoiceInk.surface).testTag("connection-aperture")) {
                    camera(Modifier.fillMaxSize().clearAndSetSemantics {})
                    Canvas(Modifier.fillMaxSize()) {
                        val edge = size.minDimension * .10f
                        val span = size.minDimension - edge * 2
                        val shade = Color.Black.copy(alpha = .62f)
                        drawRect(shade, size = Size(size.width, edge))
                        drawRect(shade, topLeft = Offset(0f, size.height - edge), size = Size(size.width, edge))
                        drawRect(shade, topLeft = Offset(0f, edge), size = Size(edge, span))
                        drawRect(shade, topLeft = Offset(size.width - edge, edge), size = Size(edge, span))
                        val color = if (scene in setOf(ConnectionScene.Found, ConnectionScene.Saving)) accent else ink.copy(alpha = .62f)
                        val arm = 28.dp.toPx().coerceAtMost(span / 4)
                        for (x in listOf(edge, size.width - edge)) for (y in listOf(edge, size.height - edge)) {
                            drawLine(color, Offset(x, y), Offset(x + if (x == edge) arm else -arm, y), 2.dp.toPx(), StrokeCap.Round)
                            drawLine(color, Offset(x, y), Offset(x, y + if (y == edge) arm else -arm), 2.dp.toPx(), StrokeCap.Round)
                        }
                    }
                }
                    if (scene == ConnectionScene.Scanning) Text("Looking for a code…", color = ink,
                        fontFamily = VoiceInk.type, fontSize = 12.sp,
                        modifier = Modifier
                            .semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
            val instructions: @Composable () -> Unit = {
                Column(Modifier.widthIn(max = 420.dp)) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("CONNECT AGENTVOICE", color = VoiceInk.muted, fontFamily = VoiceInk.type,
                        fontSize = 11.sp, letterSpacing = 2.sp)
                    Text(scene.title, color = ink, fontFamily = VoiceInk.type, fontSize = 26.sp,
                        lineHeight = 32.sp, modifier = Modifier.semantics { heading(); liveRegion = LiveRegionMode.Polite }
                            .testTag("connection-title"))
                    Text(scene.detail, color = VoiceInk.muted, fontFamily = VoiceInk.type, fontSize = 14.sp, lineHeight = 21.sp)
                    if (scene in setOf(ConnectionScene.Permission, ConnectionScene.Scanning)) {
                        Text("agentvoice network qr --name phone", color = ink, fontFamily = VoiceInk.type,
                            fontSize = 12.sp, lineHeight = 19.sp,
                            modifier = Modifier.background(VoiceInk.surface, RoundedCornerShape(8.dp)).padding(12.dp))
                    }
                    scene.action?.let { label ->
                        OutlinedButton(onClick = action, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, accent.copy(alpha = .55f)),
                            colors = ButtonDefaults.outlinedButtonColors(containerColor = VoiceInk.surface, contentColor = accent),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("connection-action")) {
                            Text(label, fontFamily = VoiceInk.type)
                        }
                    }
                }
                    TextButton(onClick = close, modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp).testTag("connection-close")) {
                        Text(if (studio) "Back to Studio" else "Close", color = VoiceInk.muted, fontFamily = VoiceInk.type)
                    }
                }
            }
            if (landscape) {
                Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                    if (personaSide == "left") aperture()
                    Box(Modifier.weight(1f)) { instructions() }
                    if (personaSide != "left") aperture()
                }
            } else {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterVertically)) {
                    aperture()
                    Box(Modifier.weight(1f, fill = false)) { instructions() }
                }
            }
        }
    }
}
