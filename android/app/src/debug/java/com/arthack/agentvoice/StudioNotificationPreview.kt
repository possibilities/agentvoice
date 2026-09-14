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

/** Activity-owned rehearsal; no real call state, media, or durable pending actions. */
internal class StudioNotificationPreview(private val context: Context, private val ended: () -> Unit) : AutoCloseable {
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val expiry = Runnable { close(); ended() }
    private val manager = context.getSystemService(NotificationManager::class.java)
    private var incarnation: String? = null
    private var started = 0L
    private var muted = true
    private var speakerMuted = false
    private var style = "custom"
    private val action = "${context.packageName}.STUDIO_NOTIFICATION"
    private val pending = mutableListOf<PendingIntent>()
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != action || !ownsNotificationAction(incarnation, intent.getStringExtra("incarnation"))) return
            when (intent.getStringExtra("control")) {
                "hang-up" -> { close(); ended() }
                "microphone" -> { muted = !muted; post() }
                "speaker" -> { speakerMuted = !speakerMuted; post() }
            }
        }
    }

    fun show(selectedStyle: String) {
        require(selectedStyle in previewNotificationStyles)
        style = selectedStyle
        if (incarnation == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Call notification rehearsal", NotificationManager.IMPORTANCE_LOW))
            incarnation = UUID.randomUUID().toString()
            StudioNotificationService.activeIncarnation = incarnation
            handler.postDelayed(expiry, 120_000)
            started = SystemClock.elapsedRealtime()
            muted = true
            speakerMuted = false
            ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
            for ((index, control) in listOf("hang-up", "microphone", "speaker").withIndex()) {
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
        val builder = Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification_agentvoice)
        val notification = if (style == "themed") buildThemedCallNotification(context, builder,
            state, pending[0], pending[1], pending[2], speakerMuted)
        else buildCallNotification(context, builder, state, pending[0], pending[1], style)
        ContextCompat.startForegroundService(context, Intent(context, StudioNotificationService::class.java)
            .putExtra("incarnation", incarnation).putExtra("notification", notification))
    }

    override fun close() {
        handler.removeCallbacks(expiry)
        if (ownsNotificationAction(StudioNotificationService.activeIncarnation, incarnation)) {
            StudioNotificationService.activeIncarnation = null
            context.stopService(Intent(context, StudioNotificationService::class.java))
        }
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
