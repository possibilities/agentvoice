package com.arthack.agentvoice

import android.app.Notification
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ThemedCallNotificationTest {
    @Test fun brandedDeckFitsNotificationBudgetsAndKeepsAllThreeActionsIndependent() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val received = LinkedBlockingQueue<String>()
        val action = "${context.packageName}.test.THEMED_NOTIFICATION"
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                received.add(intent.data!!.lastPathSegment!!)
            }
        }
        ContextCompat.registerReceiver(context, receiver,
            IntentFilter(action).apply { addDataScheme("test") }, ContextCompat.RECEIVER_NOT_EXPORTED)
        fun pending(name: String) = PendingIntent.getBroadcast(context, 0,
            Intent(action).setPackage(context.packageName).setData(Uri.parse("test://themed-notification/$name")),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val hangUp = pending("hang-up")
        val microphone = pending("microphone")
        val speaker = pending("speaker")
        try {
            for (night in listOf(false, true)) for (fontScale in listOf(1f, 1.3f)) {
                for (micMuted in listOf(false, true)) for (speakerMuted in listOf(false, true)) {
                    val configuration = Configuration(context.resources.configuration).apply {
                        uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                            if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
                        this.fontScale = fontScale
                    }
                    val themed = context.createConfigurationContext(configuration)
                    instrumentation.runOnMainSync {
                        val state = CallNotificationState("AgentVoice Studio", "Notification rehearsal · no call",
                            if (micMuted) "Unmute" else "Mute", SystemClock.elapsedRealtime() - 60_000)
                        val notification = buildThemedCallNotification(themed,
                            Notification.Builder(themed, "themed-notification-test")
                                .setSmallIcon(R.drawable.ic_notification_agentvoice),
                            state, hangUp, microphone, speaker, speakerMuted)
                        assertEquals(Notification.DecoratedCustomViewStyle::class.java.name,
                            notification.extras.getString(Notification.EXTRA_TEMPLATE))
                        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
                        assertTrue(notification.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
                        val density = themed.resources.displayMetrics.density
                        fun layout(view: View) {
                            view.measure(View.MeasureSpec.makeMeasureSpec((280 * density).toInt(), View.MeasureSpec.EXACTLY),
                                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                            view.layout(0, 0, view.measuredWidth, view.measuredHeight)
                        }
                        val expanded = notification.bigContentView.apply(themed, FrameLayout(themed))
                        layout(expanded)
                        assertTrue("Expanded deck must fit SystemUI", expanded.height <= 252 * density)
                        val mic = expanded.findViewById<Button>(R.id.themed_notification_microphone)
                        val audio = expanded.findViewById<Button>(R.id.themed_notification_speaker)
                        val end = expanded.findViewById<Button>(R.id.themed_notification_hang_up)
                        for (button in listOf(mic, audio, end)) {
                            assertTrue(button.height >= (48 * density).toInt())
                            assertTrue(button.width >= (48 * density).toInt())
                            assertFalse(button.contentDescription.isNullOrBlank())
                        }
                        assertEquals("Human microphone ${if (micMuted) "muted" else "on"}. ${state.micAction} microphone.",
                            mic.contentDescription.toString())
                        assertEquals("Agent audio ${if (speakerMuted) "muted" else "on"}. ${if (speakerMuted) "Unmute" else "Mute"} audio.",
                            audio.contentDescription.toString())
                        for ((id, expected) in listOf(
                            R.id.themed_notification_microphone_label to state.micAction,
                            R.id.themed_notification_speaker_label to if (speakerMuted) "Unmute" else "Mute",
                            R.id.themed_notification_hang_up_label to "Hang Up")) {
                            val label = expanded.findViewById<TextView>(id)
                            assertEquals(expected, label.text.toString())
                            assertEquals("Primary action must not ellipsize", 0, label.layout.getEllipsisCount(0))
                            assertTrue("Primary action must not clip vertically", label.layout.height <= label.height)
                        }
                        fun color(id: Int) = themed.getColor(id)
                        val humanInk = expanded.findViewById<TextView>(R.id.themed_notification_microphone_label).currentTextColor
                        val agentInk = expanded.findViewById<TextView>(R.id.themed_notification_speaker_label).currentTextColor
                        val endInk = expanded.findViewById<TextView>(R.id.themed_notification_hang_up_label).currentTextColor
                        // Check both rocker faces because the label crosses their geometric seam.
                        for (face in listOf(0xFF101311.toInt(), 0xFF1B211B.toInt(), 0xFF1E2814.toInt(), 0xFF211C30.toInt())) {
                            assertTrue(contrast(humanInk, face) >= 7.0)
                            assertTrue(contrast(agentInk, face) >= 7.0)
                        }
                        assertTrue(contrast(endInk, color(R.color.themed_notification_end)) >= 7.0)
                        assertTrue(contrast(color(R.color.themed_notification_muted), color(R.color.themed_notification_ground)) >= 4.5)
                        val compact = notification.contentView.apply(themed, FrameLayout(themed))
                        layout(compact)
                        assertTrue("Compact content has only 48dp on some Android versions", compact.height <= (48 * density).toInt())
                        for (id in listOf(R.id.themed_notification_microphone, R.id.themed_notification_hang_up)) {
                            val button = compact.findViewById<Button>(id)
                            assertTrue(button.height >= (48 * density).toInt())
                            assertTrue(button.layout.height <= button.height - button.paddingTop - button.paddingBottom)
                            for (line in 0 until button.layout.lineCount) assertEquals(0, button.layout.getEllipsisCount(line))
                        }
                        assertEquals("${state.micAction}\nmic", compact.findViewById<Button>(R.id.themed_notification_microphone).text.toString())
                        assertNull(compact.findViewById<View>(R.id.themed_notification_speaker))
                        val suffix = "${if (night) "dark" else "light"}-$fontScale-mic-$micMuted-speaker-$speakerMuted"
                        for ((size, view) in listOf("expanded" to expanded, "compact" to compact)) {
                            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                            view.draw(Canvas(bitmap))
                            File(context.cacheDir, "themed-notification-$size-$suffix.png").outputStream().use {
                                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                            }
                            bitmap.recycle()
                        }
                        assertTrue(mic.performClick())
                        assertTrue(audio.performClick())
                        assertTrue(end.performClick())
                        assertTrue(compact.findViewById<Button>(R.id.themed_notification_microphone).performClick())
                        assertTrue(compact.findViewById<Button>(R.id.themed_notification_hang_up).performClick())
                    }
                    for (expected in listOf("microphone", "speaker", "hang-up", "microphone", "hang-up")) {
                        assertEquals(expected, received.poll(3, TimeUnit.SECONDS))
                    }
                }
            }
        } finally {
            context.unregisterReceiver(receiver)
            listOf(hangUp, microphone, speaker).forEach { it.cancel() }
        }
    }

    private fun contrast(first: Int, second: Int): Double {
        fun luminance(color: Int): Double {
            fun channel(value: Int): Double {
                val normalized = value / 255.0
                return if (normalized <= 0.04045) normalized / 12.92
                else Math.pow((normalized + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(Color.red(color)) + 0.7152 * channel(Color.green(color)) +
                0.0722 * channel(Color.blue(color))
        }
        val a = luminance(first)
        val b = luminance(second)
        return (maxOf(a, b) + 0.05) / (minOf(a, b) + 0.05)
    }
}
