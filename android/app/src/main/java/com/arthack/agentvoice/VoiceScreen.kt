package com.arthack.agentvoice

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
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

internal fun requiresShippingIconCredit(family: String, paidNounIcons: Boolean): Boolean =
    family == "noun-boatman" || (family == "noun-icons" && !paidNounIcons)

internal fun voiceConnectionNoticeState(ui: CallUi): String = when {
    ui.connected -> "connected"
    ui.phase in setOf("Voice unavailable", "Voice stopped") -> "failed"
    ui.running -> "connecting"
    ui.message != null && !ui.message.startsWith("Call ended") -> "failed"
    else -> "disconnected"
}

/** The adopted scene consumes real controller state; only the debug studio synthesizes it. */
@Composable
internal fun VoiceScreen(
    ui: CallUi, stop: () -> Unit,
    mute: (String) -> Unit, hold: () -> Unit, release: () -> Unit,
    soundOutput: PreviewSwitchOutput? = null,
    connect: (() -> Unit)? = null,
) {
    val layout = shippingLayoutForOrientation(currentPreviewOrientation())
    val latestUi by rememberUpdatedState(ui)
    val feedback = rememberPreviewSwitchFeedback(ShippingDesign.sounds, soundOutput, communicationAudio = true)
    var pendingMute by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    // A directional cue belongs to this gesture's confirmed mute change, never hydration/reconnect.
    LaunchedEffect(ui.connected, ui.controlsPending, ui.micMuted, ui.speakerMuted) {
        val pending = pendingMute
        if (!ui.connected) { pendingMute = null; feedback.cancel() }
        else if (pending != null && !ui.controlsPending) {
            if ((if (pending.first == "mic") ui.micMuted else ui.speakerMuted) == pending.second)
                feedback.toggle(!pending.second)
            pendingMute = null
        }
    }
    var credits by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxSize().semantics {
        stateDescription = ui.phase
        customActions = if (ui.running) listOf(CustomAccessibilityAction("End call") { stop(); true }) else emptyList()
    }.testTag("voice-screen")) {
        PreviewStudioScreen(ui, layout.design, layout.placement,
            onMute = { target ->
                if (latestUi.connected && !latestUi.controlsPending) {
                    feedback.cancel()
                    pendingMute = target to !(if (target == "mic") latestUi.micMuted else latestUi.speakerMuted)
                    mute(target)
                }
            }, onHold = { if (latestUi.canHold && !latestUi.holding) { hold(); feedback.down() } },
            onRelease = { feedback.cancel(); release() },
            onReleaseCompleted = { release(); feedback.release() }, onExit = { if (latestUi.running) stop() },
            connection = voiceConnectionNoticeState(ui),
            halo = layout.halo, spirit = layout.spirit, activity = "steady", personaSide = layout.personaSide,
            theme = ShippingDesign.theme, mutedPresence = ShippingDesign.mutedPresence,
            mutedTuning = ShippingDesign.mutedTuning, presenceScope = ShippingDesign.presenceScope,
            horizontalOffsetDp = layout.horizontalOffsetDp, showPushToTalk = ShippingDesign.showPushToTalk,
            icons = ShippingDesign.icons, handleBack = ui.running,
            connectionStyle = ShippingDesign.connectionStyle,
            connectionDetail = ui.message ?: when (ui.phase) {
                "Voice stopped" -> "Voice stopped. End this attempt before reconnecting."
                "Voice unavailable" -> "Voice could not start. Check the server, then end this attempt and try again."
                else -> null
            },
            onConnect = if (!ui.running) connect else null,
            onCancelConnection = if (ui.running && !ui.connected) stop else null)
        if (ui.connected) ui.message?.let {
            Text(it, color = VoiceInk.text, fontFamily = VoiceInk.type, fontSize = 12.sp,
                modifier = Modifier.align(Alignment.TopCenter).safeDrawingPadding().background(VoiceInk.surface)
                    .padding(16.dp).semantics { liveRegion = LiveRegionMode.Polite })
        }
        if (!ui.running && requiresShippingIconCredit(ShippingDesign.icons.channels, BuildConfig.PAID_NOUN_ICONS))
            TextButton(onClick = { credits = true }, modifier = Modifier.align(Alignment.BottomEnd)
                .safeDrawingPadding().testTag("shipping-credits")) { Text("Credits") }
    }
    if (credits) ShippingCredits { credits = false }
}

@Composable
internal fun ShippingCredits(dismiss: () -> Unit) {
    val context = LocalContext.current
    val notice = remember(context) {
        val text = listOf("Shipping-Icons-NOTICE.txt", "Shipping-Sounds-NOTICE.txt", "Persona-Halo-NOTICE.txt")
            .joinToString("\n\n") { file -> context.assets.open("notices/$file").bufferedReader().use { it.readText() } }
        androidx.compose.ui.text.buildAnnotatedString {
            append(text)
            Regex("https://[^\\s]+").findAll(text).forEach { match ->
                addLink(androidx.compose.ui.text.LinkAnnotation.Url(match.value), match.range.first, match.range.last + 1)
            }
        }
    }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Credits") },
        text = { androidx.compose.foundation.text.selection.SelectionContainer {
            Text(notice, Modifier.verticalScroll(rememberScrollState()), fontSize = 12.sp)
        } }, confirmButton = { TextButton(onClick = dismiss) { Text("Done") } })
}
