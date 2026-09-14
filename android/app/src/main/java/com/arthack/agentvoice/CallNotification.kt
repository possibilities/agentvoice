package com.arthack.agentvoice

import android.app.Notification
import android.app.Person
import android.graphics.drawable.Icon
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
    style: String = ShippingDesign.notificationStyle,
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
    require(style in previewNotificationStyles)
    builder
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

    if (style == "call-style") {
        val person = Person.Builder().setName(state.identity)
            .setIcon(Icon.createWithResource(context, R.mipmap.ic_agentvoice))
            .setImportant(true).build()
        return builder.addAction(Notification.Action.Builder(
            Icon.createWithResource(context, R.drawable.ic_notification_agentvoice),
            state.micAction, microphone).build())
            .setStyle(Notification.CallStyle.forOngoingCall(person, hangUp)).build()
    }
    return builder.setStyle(Notification.DecoratedCustomViewStyle())
        .setCustomContentView(content(false))
        .setCustomBigContentView(content(true))
        .setCustomHeadsUpContentView(content(false))
        .build()
}
