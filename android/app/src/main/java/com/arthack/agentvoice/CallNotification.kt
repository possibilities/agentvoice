package com.arthack.agentvoice

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews

internal fun buildCallNotification(
    context: Context,
    builder: Notification.Builder,
    state: CallNotificationState,
    hangUp: PendingIntent,
    microphone: PendingIntent,
): Notification {
    fun content(expanded: Boolean) = RemoteViews(context.packageName, R.layout.call_notification).apply {
        setTextViewText(R.id.call_notification_title, state.identity)
        setTextViewText(R.id.call_notification_phase, state.phase)
        setTextViewText(R.id.call_notification_microphone, state.micAction)
        setViewVisibility(R.id.call_notification_title, if (expanded) View.GONE else View.VISIBLE)
        setViewVisibility(R.id.call_notification_actions, if (expanded) View.VISIBLE else View.GONE)
        setOnClickPendingIntent(R.id.call_notification_hang_up, hangUp)
        setOnClickPendingIntent(R.id.call_notification_microphone, microphone)
    }

    // Own both sides of button contrast: Samsung CallStyle can render white on white.
    // The microphone service and VoicePeer own call lifetime/audio, independently of this style.
    return builder
        .setCategory(Notification.CATEGORY_CALL)
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
