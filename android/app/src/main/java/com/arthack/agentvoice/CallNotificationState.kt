package com.arthack.agentvoice

internal data class CallNotificationState(
    val identity: String,
    val phase: String,
    val micAction: String,
    val startedAtElapsedRealtime: Long,
)

internal fun callNotificationState(ui: CallUi, startedAtElapsedRealtime: Long): CallNotificationState? {
    if (!ui.running) return null
    return CallNotificationState(
        identity = "AgentVoice",
        phase = ui.phase,
        micAction = if (ui.micMuted) "Unmute" else "Mute",
        startedAtElapsedRealtime = startedAtElapsedRealtime,
    )
}

internal fun notificationWhenMillis(
    nowWallMillis: Long,
    nowElapsedRealtime: Long,
    startedAtElapsedRealtime: Long,
): Long = nowWallMillis - (nowElapsedRealtime - startedAtElapsedRealtime).coerceAtLeast(0L)

internal fun ownsNotificationAction(activeSession: String?, actionSession: String?): Boolean =
    activeSession != null && activeSession == actionSession
