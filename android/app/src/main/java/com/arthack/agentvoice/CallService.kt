package com.arthack.agentvoice

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock

/** Process-local owner for one active call. Credentials enter only through [LocalBinder.startCall]. */
internal class CallService : Service() {
    inner class LocalBinder : Binder() {
        val controller: OwnedCallController get() = owner.controller

        /** The caller must be a resumed Activity with microphone permission. */
        fun startCall(credential: CallCredential) {
            check(Looper.myLooper() == Looper.getMainLooper())
            if (owner.controller.ui.running) return
            preparationTimeout?.let(main::removeCallbacks)
            preparationTimeout = null
            prepareConsumed = !preparingForeground
            preparingForeground = false
            owner.start(credential)
        }

        fun disconnect() {
            check(Looper.myLooper() == Looper.getMainLooper())
            owner.disconnect()
            if (!owner.controller.ui.running) settleIdle()
        }
    }

    private val binder = LocalBinder()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var owner: CallOwner
    private lateinit var callWakeLock: PowerManager.WakeLock
    private var foreground = false
    private var preparingForeground = false
    private var prepareConsumed = false
    private var preparationTimeout: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        callWakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:active-call")
            .apply { setReferenceCounted(false) }
        owner = CallOwner(
            controllerFactory = { changed -> CallController(applicationContext, onUiChanged = changed) },
            nowElapsedRealtime = SystemClock::elapsedRealtime,
            notificationChanged = ::onNotificationChanged,
            lifetimeStarted = ::acquireCallWakeLock,
            lifetimeEnded = ::releaseCallWakeLock,
        )
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PREPARE -> when {
                owner.controller.ui.running -> {
                    prepareConsumed = false
                }
                prepareConsumed -> {
                    prepareConsumed = false
                    settleIdle()
                }
                else -> beginBoundedPreparation()
            }
            ACTION_TOGGLE_MIC -> {
                owner.toggleMicrophone(intent.getStringExtra(EXTRA_SESSION))
                if (!owner.controller.ui.running) settleIdle()
            }
            ACTION_HANG_UP -> {
                owner.hangUp(intent.getStringExtra(EXTRA_SESSION))
                if (!owner.controller.ui.running) settleIdle()
            }
            else -> if (!owner.controller.ui.running) settleIdle()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        preparationTimeout?.let(main::removeCallbacks)
        preparationTimeout = null
        try {
            if (::owner.isInitialized) owner.dispose()
        } finally {
            releaseCallWakeLock()
        }
        super.onDestroy()
    }

    private fun beginBoundedPreparation() {
        if (preparingForeground) return
        preparingForeground = true
        val notification = baseNotification("Starting AgentVoice")
            .setContentText("Preparing call")
            .setOngoing(true)
            .build()
        enterForeground(notification)
        Runnable {
            preparationTimeout = null
            if (!owner.controller.ui.running) settleIdle()
        }.also {
            preparationTimeout = it
            main.postDelayed(it, PREPARE_TIMEOUT_MILLIS)
        }
    }

    private fun onNotificationChanged(state: CallNotificationState?, session: String?) {
        if (state == null || session == null) {
            settleIdle()
            return
        }
        val hangUp = servicePendingIntent(ACTION_HANG_UP, session, 1)
        val mic = servicePendingIntent(ACTION_TOGGLE_MIC, session, 2)
        val person = Person.Builder()
            .setName(state.identity)
            .setIcon(Icon.createWithResource(this, R.mipmap.ic_agentvoice))
            .setImportant(true)
            .build()
        val notification = baseNotification(state.identity, session)
            .setCategory(Notification.CATEGORY_CALL)
            .setContentText(state.phase)
            .setWhen(notificationWhenMillis(System.currentTimeMillis(), SystemClock.elapsedRealtime(),
                state.startedAtElapsedRealtime))
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(Notification.Action.Builder(
                Icon.createWithResource(this, R.drawable.ic_notification_agentvoice), state.micAction, mic).build())
            .setStyle(Notification.CallStyle.forOngoingCall(person, hangUp))
            .build()
        enterForeground(notification)
    }

    // Studio compiles shared sources but removes this service and every voice capability from its manifest.
    // The production APK audit verifies the declared microphone type before this code can ship there.
    @SuppressLint("ForegroundServiceType")
    private fun enterForeground(notification: Notification) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        foreground = true
    }

    // A legitimate call has no fixed duration; CallOwner bounds this lock from successful
    // foreground publication through its single terminal cleanup path. Studio removes both.
    @SuppressLint("WakelockTimeout", "MissingPermission")
    private fun acquireCallWakeLock() {
        if (!callWakeLock.isHeld) callWakeLock.acquire()
    }

    private fun releaseCallWakeLock() {
        if (::callWakeLock.isInitialized) runCatching {
            if (callWakeLock.isHeld) callWakeLock.release()
        }
    }

    private fun settleIdle() {
        preparationTimeout?.let(main::removeCallbacks)
        preparationTimeout = null
        preparingForeground = false
        releaseCallWakeLock()
        if (foreground) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            foreground = false
        }
        stopSelf()
    }

    private fun servicePendingIntent(action: String, session: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, CallService::class.java)
            .setAction(action)
            .setData(Uri.Builder().scheme("agentvoice").authority("call")
                .appendPath(session).appendPath(action).build())
            .putExtra(EXTRA_SESSION, session)
        return PendingIntent.getService(this, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun baseNotification(title: String, session: String? = null): Notification.Builder {
        val contentIntent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_RETURN_TO_CALL, true)
        if (session != null) contentIntent.data = Uri.Builder().scheme("agentvoice")
            .authority("call").appendPath(session).appendPath("return").build()
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_agentvoice)
            .setContentTitle(title)
            .setContentIntent(PendingIntent.getActivity(this, 0, contentIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Active calls", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Ongoing AgentVoice calls"
            setSound(null, null)
            enableVibration(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "active_calls"
        private const val NOTIFICATION_ID = 41
        private const val PREPARE_TIMEOUT_MILLIS = 10_000L
        private const val ACTION_PREPARE = "com.arthack.agentvoice.action.PREPARE_CALL"
        private const val ACTION_TOGGLE_MIC = "com.arthack.agentvoice.action.TOGGLE_MIC"
        private const val ACTION_HANG_UP = "com.arthack.agentvoice.action.HANG_UP"
        private const val EXTRA_SESSION = "com.arthack.agentvoice.extra.CALL_SESSION"
        private const val EXTRA_RETURN_TO_CALL = "com.arthack.agentvoice.extra.RETURN_TO_CALL"

        /** Call only from a resumed Activity after its while-in-use permissions are granted. */
        fun requestForegroundStart(context: Context) {
            context.startForegroundService(Intent(context, CallService::class.java).setAction(ACTION_PREPARE))
        }

        fun isReturnToCall(intent: Intent?): Boolean =
            intent?.getBooleanExtra(EXTRA_RETURN_TO_CALL, false) == true

        fun notificationsAllowed(context: Context): Boolean =
            Build.VERSION.SDK_INT < 33 ||
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
}
