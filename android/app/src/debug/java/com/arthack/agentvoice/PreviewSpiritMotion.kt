package com.arthack.agentvoice

import android.animation.ValueAnimator
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.isActive
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt

internal fun spiritEnvelope(previous: Float, target: Float, seconds: Float, open: Boolean): Float {
    if (!open) return 0f
    val from = if (previous.isFinite()) previous.coerceIn(0f, 1f) else 0f
    val to = if (target.isFinite()) target.coerceIn(0f, 1f) else 0f
    val dt = if (seconds.isFinite()) seconds.coerceIn(0f, .1f) else 0f
    val time = if (to > from) .2f else .85f
    return from + (to - from) * (1f - exp(-dt / time))
}

/** A deterministic rehearsal envelope, never an audio source or a claim of measured speech. */
internal fun syntheticSpiritEnergy(seconds: Float): Float {
    val phrase = (seconds % 4.8f) / 4.8f
    if (phrase > .76f) return 0f
    val breath = sin(phrase / .76f * PI).toFloat().coerceAtLeast(0f)
    val syllable = (.5f + .5f * sin(seconds * 2f * PI * 2.1f).toFloat())
    return breath * (.2f + .7f * syllable * syllable)
}

internal data class PreviewSpiritFrame(val light: PreviewButtonLight, val colors: CompactHaloColors)

private data class SpiritColorCue(
    val palette: CompactHaloColors,
    val state: PersonaState,
    val capture: Boolean,
    val playback: Boolean,
    val pending: Boolean,
)

/** One slow scene clock, with gate changes kept separate from its trailing energy. */
internal class PreviewSpiritMotion(initialColors: CompactHaloColors = CompactHaloColors()) {
    private var seconds = 0f
    private var capture = 0f
    private var playback = 0f
    private var amount = 0f
    private var colors = initialColors
    private var colorAnchor = initialColors
    private var colorCue: SpiritColorCue? = null
    private var colorStart = 0f

    fun step(ui: CallUi, spirit: PreviewSpirit, base: CompactHaloColors, contained: Boolean,
        activity: String, deltaSeconds: Float, motionAllowed: Boolean): PreviewSpiritFrame {
        val follows = contained && spirit.persona == "follow"
        val moving = motionAllowed && ui.connected && !ui.controlsPending
        if (!moving) {
            capture = 0f
            playback = 0f
            amount = 0f
            colors = if (follows) personaSpiritColors(base, ui, 0f, motionAllowed = false) else base
            colorCue = null
            return PreviewSpiritFrame(PreviewButtonLight(), colors)
        }
        val dt = if (deltaSeconds.isFinite()) deltaSeconds.coerceIn(0f, .1f) else 0f
        seconds += dt
        val phase = (seconds / 14f) % 1f
        val state = personaState(ui)
        fun normalized(level: Float) = if (level.isFinite()) sqrt((level / .3f).coerceIn(0f, 1f)) else 0f
        val demo = syntheticSpiritEnergy(seconds)
        val captureTarget = if (activity == "voice") { if (state == PersonaState.Listening) demo else 0f } else normalized(ui.inputLevel)
        val playbackTarget = if (activity == "voice") { if (state == PersonaState.Speaking) demo else 0f } else normalized(ui.outputLevel)
        capture = spiritEnvelope(capture, captureTarget, dt, ui.micOpen)
        playback = spiritEnvelope(playback, playbackTarget, dt, ui.speakerOpen)
        val targetAmount = if (spirit.surface == "soft") spirit.strengthPercent / 100f else 0f
        amount = if (targetAmount == 0f) 0f else amount + (targetAmount - amount) * (1f - exp(-dt / .35f))

        if (follows) {
            val cue = SpiritColorCue(base, state, ui.micOpen, ui.speakerOpen, ui.controlsPending)
            if (cue != colorCue) {
                colorAnchor = colors
                colorStart = seconds
                colorCue = cue
            }
            val energy = when (state) { PersonaState.Listening -> capture; PersonaState.Speaking -> playback; else -> 0f }
            val target = personaSpiritColors(base, ui, phase, energy)
            colors = blendPersonaSpiritColors(colorAnchor, target, ((seconds - colorStart) / .9f).coerceIn(0f, 1f))
        } else {
            colors = base
            colorCue = null
        }
        return PreviewSpiritFrame(PreviewButtonLight(phase, amount, capture, playback), colors)
    }
}

internal class PreviewSpiritScene(val light: State<PreviewButtonLight>, val colors: State<CompactHaloColors>)

@Composable
internal fun previewSpiritMotionAllowed(): Boolean {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var reduced by remember { mutableStateOf(!ValueAnimator.areAnimatorsEnabled()) }
    DisposableEffect(lifecycle, context) {
        val observer = LifecycleEventObserver { _, _ -> resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        val motion = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { reduced = !ValueAnimator.areAnimatorsEnabled() }
        }
        lifecycle.addObserver(observer)
        context.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, motion)
        onDispose {
            lifecycle.removeObserver(observer)
            context.contentResolver.unregisterContentObserver(motion)
        }
    }
    return resumed && !reduced
}

@Composable
internal fun rememberPreviewSpirit(
    ui: CallUi,
    spirit: PreviewSpirit,
    halo: PreviewHalo,
    activity: String,
    motionAllowed: Boolean = previewSpiritMotionAllowed(),
): PreviewSpiritScene {
    val base = halo.colors()
    val light = remember { mutableStateOf(PreviewButtonLight()) }
    val colors = remember { mutableStateOf(base) }
    val motion = remember { PreviewSpiritMotion(base) }
    val latestUi by rememberUpdatedState(ui)
    val latestSpirit by rememberUpdatedState(spirit)
    val latestHalo by rememberUpdatedState(halo)
    val latestActivity by rememberUpdatedState(activity)
    val enabled = (spirit.surface == "soft" && spirit.strengthPercent > 0) || (halo.variant == "contained" && spirit.persona == "follow")
    val moving = enabled && motionAllowed && ui.connected && !ui.controlsPending
    fun publish(frame: PreviewSpiritFrame) {
        light.value = frame.light
        colors.value = frame.colors
    }
    SideEffect {
        if (!moving) publish(motion.step(ui, spirit, base, halo.variant == "contained", activity, 0f, false))
    }
    LaunchedEffect(moving) {
        if (!moving) return@LaunchedEffect
        var previous = withFrameNanos { it }
        while (isActive) {
            val now = withFrameNanos { it }
            val elapsed = (now - previous) / 1_000_000_000f
            if (elapsed < 1f / 30f) continue
            previous = now
            publish(motion.step(latestUi, latestSpirit, latestHalo.colors(), latestHalo.variant == "contained",
                latestActivity, elapsed, true))
        }
    }
    return remember { PreviewSpiritScene(light, colors) }
}
