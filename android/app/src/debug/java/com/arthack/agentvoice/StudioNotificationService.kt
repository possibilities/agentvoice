package com.arthack.agentvoice

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Android requires foreground ownership for CallStyle; this short rehearsal owns no media. */
class StudioNotificationService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!ownsNotificationAction(activeIncarnation, intent?.getStringExtra("incarnation"))) {
            if (activeIncarnation == null) stopSelf()
            return START_NOT_STICKY
        }
        @Suppress("DEPRECATION")
        val notification = intent?.getParcelableExtra<Notification>("notification")
        if (notification == null) { stopSelf(); return START_NOT_STICKY }
        startForeground(StudioNotificationPreview.ID, notification,
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE else 0)
        return START_NOT_STICKY
    }
    override fun onTimeout(startId: Int) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
    override fun onTimeout(startId: Int, fgsType: Int) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
    override fun onDestroy() { stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy() }
    companion object {
        @Volatile internal var activeIncarnation: String? = null
    }
}
