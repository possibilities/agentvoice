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
        setContentDescription(R.id.themed_notification_microphone, description(false, micMuted, state.micAction))
        setOnClickPendingIntent(R.id.themed_notification_microphone, microphone)
        setOnClickPendingIntent(R.id.themed_notification_hang_up, hangUp)
        setTextViewText(R.id.themed_notification_microphone,
            context.getString(R.string.themed_notification_microphone_label, state.micAction))
        if (expanded) {
            setTextViewText(R.id.themed_notification_phase, state.phase)
            setTextViewText(R.id.themed_notification_speaker,
                context.getString(R.string.themed_notification_speaker_label, speakerAction))
            setContentDescription(R.id.themed_notification_speaker, description(true, speakerMuted, speakerAction))
            setOnClickPendingIntent(R.id.themed_notification_speaker, speaker)
        }
    }

    // Keep the root transparent: SystemUI already supplies the card and app identity.
    // Button ink and surfaces are paired in values/values-night, independently of OEM action tints.
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
