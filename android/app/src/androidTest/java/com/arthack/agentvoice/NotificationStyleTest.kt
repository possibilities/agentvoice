package com.arthack.agentvoice

import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class NotificationStyleTest {
    @Test fun originalCallStyleKeepsSystemActionsAndDoesNotUseCustomViews() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val hangUp = PendingIntent.getBroadcast(context, 901, Intent("test.end").setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE)
        val mic = PendingIntent.getBroadcast(context, 902, Intent("test.mic").setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE)
        try {
            for (label in listOf("Mute", "Unmute")) {
                val notification = buildCallNotification(context,
                    Notification.Builder(context, "test").setSmallIcon(R.drawable.ic_notification_agentvoice),
                    CallNotificationState("AgentVoice", "Connected", label, 0), hangUp, mic, "call-style")
                assertEquals(Notification.CallStyle::class.java.name, notification.extras.getString(Notification.EXTRA_TEMPLATE))
                assertNull(notification.contentView)
                assertNull(notification.bigContentView)
                assertEquals(Notification.CATEGORY_CALL, notification.category)
                assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
                assertTrue(notification.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
                assertTrue(notification.actions.any { it.actionIntent == mic && it.title.toString() == label })
                assertTrue(notification.actions.any { it.actionIntent == hangUp })
            }
        } finally { hangUp.cancel(); mic.cancel() }
    }

    @Test fun selectionPersistsButAuditionDoesNotReplayOrRewriteLegacyCheckpoint() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.cacheDir, "notification-draft-${UUID.randomUUID()}.json")
        try {
            val current = PersonaPreviewState(notificationStyle = "call-style", connectionPreview = "notification")
            val restored = restorePersonaPreview(current.json(), current.saved)
            assertEquals("call-style", restored.notificationStyle)
            assertEquals("off", restored.connectionPreview)
            assertEquals("custom", shippingAppearance().notificationStyle)
            val profile = current.designProfile()
            assertEquals(24, JSONObject(profile).getInt("version"))
            assertEquals("call-style", decodeDesignAppearanceProfile(profile).notificationStyle)
            assertFalse(JSONObject(profile).has("connectionPreview"))
            val legacy = JSONObject(profile).put("version", 23).apply { remove("notificationStyle") }.toString()
            val bytes = JSONObject().put("version", 3).put("profile", JSONObject(legacy)).toString()
            file.writeText(bytes)
            val draft = StudioDraft(file)
            assertEquals("custom", decodeDesignAppearanceProfile(draft.open()).notificationStyle)
            assertEquals(bytes, file.readText())
            draft.write(profile)
            assertEquals("call-style", decodeDesignAppearanceProfile(StudioDraft(file).open()).notificationStyle)
            assertTrue(runCatching { decodeDesignAppearance(current.appearance().json().put("notificationStyle", "unknown")) }.isFailure)
        } finally { file.delete() }
    }

    @Test fun rehearsalActionsAreFencedAndCloseRemovesOnlyItsNotification() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        assertTrue("Allow Studio notifications before running this device test", manager.areNotificationsEnabled())
        val ended = java.util.concurrent.atomic.AtomicInteger()
        val preview = StudioNotificationPreview(context) { ended.incrementAndGet() }
        fun notification(): Notification? = manager.activeNotifications.firstOrNull { it.id == StudioNotificationPreview.ID }?.notification
        fun awaitNotification(predicate: (Notification?) -> Boolean) {
            val deadline = android.os.SystemClock.elapsedRealtime() + 3000
            while (!predicate(notification()) && android.os.SystemClock.elapsedRealtime() < deadline) android.os.SystemClock.sleep(25)
            assertTrue(predicate(notification()))
        }
        try {
            preview.show("call-style")
            awaitNotification { it?.actions?.any { action -> action.title.toString() == "Unmute" } == true }
            val first = notification()!!
            val mic = first.actions.single { it.title.toString() == "Unmute" }.actionIntent
            mic.send()
            awaitNotification { it?.actions?.any { action -> action.title.toString() == "Mute" } == true }
            preview.close()
            preview.show("call-style")
            assertTrue(runCatching { mic.send() }.exceptionOrNull() is PendingIntent.CanceledException)
            context.sendBroadcast(Intent("${context.packageName}.STUDIO_NOTIFICATION").setPackage(context.packageName)
                .putExtra("incarnation", "stale").putExtra("control", "hang-up"))
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            assertEquals(0, ended.get())
            awaitNotification { it?.actions?.any { action -> action.title.toString() == "Unmute" } == true }
            notification()!!.actions.single { it.title.toString() != "Unmute" }.actionIntent.send()
            awaitNotification { it == null }
            assertEquals(1, ended.get())
        } finally { preview.close() }
    }

}
