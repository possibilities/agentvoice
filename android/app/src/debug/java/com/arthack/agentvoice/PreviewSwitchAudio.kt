package com.arthack.agentvoice

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.ConcurrentHashMap

internal enum class PreviewSwitchCue(val file: String) { ToggleOn("toggle-on"), ToggleOff("toggle-off"), Down("ptt-down"), Up("ptt-up") }

internal interface PreviewSwitchOutput {
    /** False means unavailable now; interaction feedback must never be queued for later. */
    fun play(family: String, cue: PreviewSwitchCue, gain: Float): Boolean
    fun stop()
}

internal class PreviewSwitchFeedback(private val output: PreviewSwitchOutput) {
    private var settings = PreviewSounds()
    private var foreground = false
    private var held: PreviewSounds? = null

    fun update(next: PreviewSounds, active: Boolean) {
        if (next != settings || active != foreground) {
            held = null
            output.stop()
        }
        settings = next
        foreground = active
    }
    private fun play(cue: PreviewSwitchCue): Boolean = foreground && settings.family != "off" &&
        settings.volumePercent > 0 && output.play(settings.family, cue, settings.volumePercent / 100f)

    fun toggle(open: Boolean) { play(if (open) PreviewSwitchCue.ToggleOn else PreviewSwitchCue.ToggleOff) }
    fun down() {
        if (held != null) return
        if (play(PreviewSwitchCue.Down)) held = settings
    }
    fun release() {
        val accepted = held
        held = null
        if (accepted != null && accepted == settings) play(PreviewSwitchCue.Up)
    }
    fun cancel() { held = null; output.stop() }
}

/** Debug-local media output. Never requests focus, changes volume or feeds a voice track. */
internal class PreviewSwitchPool(context: Context) : PreviewSwitchOutput, AutoCloseable {
    private val pool = SoundPool.Builder().setMaxStreams(3).setAudioAttributes(
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()).build()
    private val ready = ConcurrentHashMap.newKeySet<Int>()
    private val samples = mutableMapOf<Pair<String, PreviewSwitchCue>, Int>()
    private val streams = mutableSetOf<Int>()
    private var closed = false
    val readyCount get() = ready.size

    init {
        pool.setOnLoadCompleteListener { _, id, status -> if (status == 0 && !closed) ready.add(id) }
        for (family in listOf("rocker-29", "rocker-13")) for (cue in PreviewSwitchCue.entries) {
            val id = context.assets.openFd("switch-sounds/$family-${cue.file}.wav").use { pool.load(it, 1) }
            samples[family to cue] = id
        }
    }
    override fun play(family: String, cue: PreviewSwitchCue, gain: Float): Boolean {
        if (closed || gain <= 0f) return false
        val id = samples[family to cue] ?: return false
        if (id !in ready) return false
        // Keep bookkeeping bounded; SoundPool itself expires completed voices.
        if (streams.size >= 3) pool.stop(streams.first().also { streams.remove(it) })
        val stream = pool.play(id, gain.coerceIn(0f, 1f), gain.coerceIn(0f, 1f), 1, 0, 1f)
        if (stream != 0) streams.add(stream)
        return stream != 0
    }
    override fun stop() { streams.forEach(pool::stop); streams.clear() }
    override fun close() { if (!closed) { closed = true; stop(); ready.clear(); pool.release() } }
}

@Composable
internal fun rememberPreviewSwitchFeedback(settings: PreviewSounds, output: PreviewSwitchOutput? = null): PreviewSwitchFeedback {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val player = remember(output) { output ?: PreviewSwitchPool(context.applicationContext) }
    val feedback = remember(player) { PreviewSwitchFeedback(player) }
    val latestSettings by rememberUpdatedState(settings)
    SideEffect { feedback.update(settings, lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(lifecycle, feedback) {
        val observer = LifecycleEventObserver { _, _ ->
            feedback.update(latestSettings, lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); feedback.cancel(); if (output == null) (player as PreviewSwitchPool).close() }
    }
    return feedback
}
