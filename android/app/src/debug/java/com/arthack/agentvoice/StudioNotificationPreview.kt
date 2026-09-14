package com.arthack.agentvoice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.util.UUID

/** Activity-owned rehearsal; no service, real call state, media, or durable pending actions. */
internal class StudioNotificationPreview(private val context: Context, private val ended: () -> Unit) : AutoCloseable {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private var incarnation: String? = null
    private var started = 0L
    private var muted = true
    private var style = "custom"
    private val action = "${context.packageName}.STUDIO_NOTIFICATION"
    private val pending = mutableListOf<PendingIntent>()
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != action || !ownsNotificationAction(incarnation, intent.getStringExtra("incarnation"))) return
            when (intent.getStringExtra("control")) {
                "hang-up" -> { close(); ended() }
                "microphone" -> { muted = !muted; post() }
            }
        }
    }

    fun show(selectedStyle: String) {
        require(selectedStyle in previewNotificationStyles)
        style = selectedStyle
        if (incarnation == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Call notification rehearsal", NotificationManager.IMPORTANCE_LOW))
            incarnation = UUID.randomUUID().toString()
            started = SystemClock.elapsedRealtime()
            muted = true
            ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
            for ((index, control) in listOf("hang-up", "microphone").withIndex()) {
                pending += PendingIntent.getBroadcast(context, index, Intent(action).setPackage(context.packageName)
                    .putExtra("incarnation", incarnation).putExtra("control", control),
                    PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
        }
        check(manager.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE) { "Enable the Studio call notification rehearsal channel in Android settings" }
        post()
    }

    private fun post() {
        if (incarnation == null) return
        val state = CallNotificationState("AgentVoice Studio", "Notification rehearsal · no call",
            if (muted) "Unmute" else "Mute", started)
        manager.notify(ID, buildCallNotification(context,
            Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification_agentvoice),
            state, pending[0], pending[1], style))
    }

    override fun close() {
        if (incarnation != null) {
            incarnation = null
            context.unregisterReceiver(receiver)
        }
        pending.forEach { it.cancel() }
        pending.clear()
        manager.cancel(ID)
    }

    companion object {
        private const val CHANNEL = "studio-call-notification"
        internal const val ID = 8142
    }
}
