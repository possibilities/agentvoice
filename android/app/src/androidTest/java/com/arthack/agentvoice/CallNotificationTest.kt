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
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class CallNotificationTest {
    @Test fun customControlsRemainReadableAndDeliverDistinctActionsInBothThemes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val received = LinkedBlockingQueue<String>()
        val action = "${context.packageName}.test.NOTIFICATION_ACTION"
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                received.add(intent.data!!.lastPathSegment!!)
            }
        }
        val filter = IntentFilter(action).apply { addDataScheme("test") }
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(receiver, filter)
        }
        fun pending(name: String) = PendingIntent.getBroadcast(context, 0,
            Intent(action).setPackage(context.packageName).setData(Uri.parse("test://notification/$name")),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val hangUp = pending("hang-up")
        val mic = pending("microphone")
        try {
            for (night in listOf(false, true)) for (muted in listOf(false, true)) {
                val configuration = Configuration(context.resources.configuration).apply {
                    uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                        if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
                }
                val themed = context.createConfigurationContext(configuration)
                instrumentation.runOnMainSync {
                    val state = callNotificationState(CallUi(running = true, phase = "Connected", micMuted = muted),
                        SystemClock.elapsedRealtime() - 60_000)!!
                    val notification = buildCallNotification(themed,
                        Notification.Builder(themed, "notification-test").setSmallIcon(R.drawable.ic_notification_agentvoice),
                        state, hangUp, mic)
                    assertEquals(Notification.DecoratedCustomViewStyle::class.java.name,
                        notification.extras.getString(Notification.EXTRA_TEMPLATE))
                    assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
                    assertTrue(notification.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
                    val expanded = notification.bigContentView.apply(themed, FrameLayout(themed))
                    val microphone = expanded.findViewById<Button>(R.id.call_notification_microphone)
                    val end = expanded.findViewById<Button>(R.id.call_notification_hang_up)
                    assertEquals(if (muted) "Unmute" else "Mute", microphone.text.toString())
                    assertEquals("Hang Up", end.text.toString())
                    assertTrue(contrast(microphone.currentTextColor, Color.rgb(242, 242, 242)) >= 7.0)
                    assertTrue(contrast(end.currentTextColor, Color.rgb(166, 27, 41)) >= 7.0)
                    val collapsed = notification.contentView.apply(themed, FrameLayout(themed))
                    assertEquals(View.GONE, collapsed.findViewById<View>(R.id.call_notification_actions).visibility)
                    assertEquals("Connected", collapsed.findViewById<TextView>(R.id.call_notification_phase).text.toString())
                    val density = themed.resources.displayMetrics.density
                    expanded.measure(View.MeasureSpec.makeMeasureSpec((300 * density).toInt(), View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                    expanded.layout(0, 0, expanded.measuredWidth, expanded.measuredHeight)
                    assertTrue(microphone.height >= (48 * density).toInt())
                    assertTrue(expanded.height <= 252 * density)
                    val bitmap = Bitmap.createBitmap(expanded.width, expanded.height, Bitmap.Config.ARGB_8888)
                    expanded.draw(Canvas(bitmap))
                    File(context.cacheDir, "call-notification-${if (night) "dark" else "light"}-${state.micAction}.png")
                        .outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                    assertTrue(microphone.performClick())
                    assertTrue(end.performClick())
                }
                assertEquals("microphone", received.poll(3, TimeUnit.SECONDS))
                assertEquals("hang-up", received.poll(3, TimeUnit.SECONDS))
            }
        } finally {
            context.unregisterReceiver(receiver)
            hangUp.cancel()
            mic.cancel()
        }
    }

    private fun contrast(a: Int, b: Int): Double {
        fun luminance(color: Int): Double {
            fun channel(value: Int): Double {
                val normalized = value / 255.0
                return if (normalized <= 0.04045) normalized / 12.92
                else Math.pow((normalized + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(Color.red(color)) + 0.7152 * channel(Color.green(color)) +
                0.0722 * channel(Color.blue(color))
        }
        val first = luminance(a)
        val second = luminance(b)
        return (maxOf(first, second) + 0.05) / (minOf(first, second) + 0.05)
    }
}
