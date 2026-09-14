package com.arthack.agentvoice

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.os.SystemClock
import android.widget.RemoteViews

/** Studio audition: RemoteViews clicks toggle rehearsal gates; they cannot model a held PTT. */
internal fun buildThemedCallNotification(
    context: Context,
    builder: Notification.Builder,
    state: CallNotificationState,
    hangUp: PendingIntent,
    microphone: PendingIntent,
    speaker: PendingIntent,
    speakerMuted: Boolean,
): Notification {
    val micMuted = state.micAction == "Unmute"
    val speakerAction = context.getString(if (speakerMuted) R.string.themed_notification_unmute
        else R.string.themed_notification_mute)
    fun description(speakerChannel: Boolean, muted: Boolean, action: String) = context.getString(
        if (speakerChannel) R.string.themed_notification_speaker_action
        else R.string.themed_notification_microphone_action,
        context.getString(if (muted) R.string.themed_notification_muted_state
            else R.string.themed_notification_open_state), action)

    fun content(expanded: Boolean) = RemoteViews(context.packageName,
        if (expanded) R.layout.themed_notification_expanded else R.layout.themed_notification_compact).apply {
        setTextViewText(R.id.themed_notification_title, state.identity)
        setTextViewText(R.id.themed_notification_phase, state.phase)
        setContentDescription(R.id.themed_notification_microphone, description(false, micMuted, state.micAction))
        setOnClickPendingIntent(R.id.themed_notification_microphone, microphone)
        setOnClickPendingIntent(R.id.themed_notification_hang_up, hangUp)
        if (expanded) {
            setTextViewText(R.id.themed_notification_microphone_label, state.micAction)
            setTextViewText(R.id.themed_notification_speaker_label, speakerAction)
            setInt(R.id.themed_notification_human_face, "setBackgroundResource",
                if (micMuted) R.drawable.themed_notification_human_muted else R.drawable.themed_notification_human_open)
            setInt(R.id.themed_notification_agent_face, "setBackgroundResource",
                if (speakerMuted) R.drawable.themed_notification_agent_muted else R.drawable.themed_notification_agent_open)
            setImageViewResource(R.id.themed_notification_mic_icon,
                if (micMuted) R.drawable.themed_notification_mic_muted else R.drawable.themed_notification_mic)
            setImageViewResource(R.id.themed_notification_speaker_icon,
                if (speakerMuted) R.drawable.themed_notification_speaker_muted else R.drawable.themed_notification_speaker)
            setContentDescription(R.id.themed_notification_speaker, description(true, speakerMuted, speakerAction))
            setOnClickPendingIntent(R.id.themed_notification_speaker, speaker)
        } else {
            setTextViewText(R.id.themed_notification_microphone,
                context.getString(R.string.themed_notification_mic_compact, state.micAction))
            setInt(R.id.themed_notification_microphone, "setBackgroundResource",
                if (micMuted) R.drawable.themed_notification_human_muted else R.drawable.themed_notification_human_open)
        }
    }

    // SystemUI owns the surrounding header/frame. The inner deck owns every ink/face pair.
    return builder.setCategory(Notification.CATEGORY_CALL)
        .setContentTitle(state.identity)
        .setContentText(state.phase)
        .setWhen(notificationWhenMillis(System.currentTimeMillis(), SystemClock.elapsedRealtime(),
            state.startedAtElapsedRealtime))
        .setShowWhen(true)
        .setUsesChronometer(true)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        .setStyle(Notification.DecoratedCustomViewStyle())
        .setCustomContentView(content(false))
        .setCustomBigContentView(content(true))
        .setCustomHeadsUpContentView(content(false))
        .build()
}
