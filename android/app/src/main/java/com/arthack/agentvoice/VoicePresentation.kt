package com.arthack.agentvoice

import androidx.compose.runtime.staticCompositionLocalOf

/** Activity preparation is presentation evidence, never permission to open media or enable a control. */
internal enum class VoicePreparation { None, Loading, Starting, AwaitingAction, Unavailable }

internal enum class VoicePresentation(val connection: String, val label: String, val illuminated: Boolean = false) {
    Preparing("connecting", "Preparing…", true),
    Connecting("connecting", "Connecting", true),
    AwaitingAction("connecting", "Action needed", true),
    Connected("connected", "Connected"),
    Disconnected("disconnected", "Disconnected"),
    Failed("failed", "Couldn’t connect"),
}

internal fun voicePreparation(
    loaded: Boolean, ownerReady: Boolean, ownerFailed: Boolean, loadFailed: Boolean,
    autoConnectPending: Boolean, selecting: Boolean, awaitingAction: Boolean,
): VoicePreparation = when {
    ownerFailed || loadFailed -> VoicePreparation.Unavailable
    awaitingAction -> VoicePreparation.AwaitingAction
    selecting -> VoicePreparation.Starting
    !loaded || !ownerReady || autoConnectPending -> VoicePreparation.Loading
    else -> VoicePreparation.None
}

internal fun voicePresentation(ui: CallUi, preparation: VoicePreparation = VoicePreparation.None): VoicePresentation = when {
    ui.connected -> VoicePresentation.Connected
    ui.takeover != null || preparation == VoicePreparation.AwaitingAction -> VoicePresentation.AwaitingAction
    // A deliberate retry prepares credentials before the old failed snapshot is replaced.
    preparation == VoicePreparation.Starting -> VoicePresentation.Preparing
    ui.phase in setOf("Voice unavailable", "Voice stopped") -> VoicePresentation.Failed
    ui.running -> if (ui.hasReachedLive) VoicePresentation.Disconnected else VoicePresentation.Connecting
    preparation == VoicePreparation.Unavailable -> VoicePresentation.Failed
    ui.message != null && !ui.message.startsWith("Call ended") -> VoicePresentation.Failed
    preparation == VoicePreparation.Loading -> VoicePresentation.Preparing
    else -> VoicePresentation.Disconnected
}

internal fun previewVoicePresentation(connection: String): VoicePresentation = when (connection) {
    "connected" -> VoicePresentation.Connected
    "connecting" -> VoicePresentation.Connecting
    "failed" -> VoicePresentation.Failed
    else -> VoicePresentation.Disconnected
}

/** Scene-owned decoration and unavailable copy; gestures still read only the real CallUi gates. */
internal val LocalVoicePresentation = staticCompositionLocalOf { VoicePresentation.Disconnected }
