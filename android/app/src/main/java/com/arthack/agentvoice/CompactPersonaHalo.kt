@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.MotionEvent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.rive.runtime.kotlin.RiveAnimationView
import app.rive.runtime.kotlin.controllers.RiveFileController
import app.rive.runtime.kotlin.core.Fit
import app.rive.runtime.kotlin.core.PlayableInstance
import app.rive.runtime.kotlin.core.Rive
import app.rive.runtime.kotlin.renderers.Renderer
import app.rive.runtime.kotlin.renderers.RiveArtboardRenderer
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.delay

@Composable
internal fun CompactPersonaHalo(
    ui: CallUi,
    modifier: Modifier,
    placement: PersonaPlacement,
    tuning: CompactHaloTuning,
    colors: CompactHaloColors = CompactHaloColors(),
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var reducedMotion by remember { mutableStateOf(!personaAnimationsEnabled(context)) }
    DisposableEffect(lifecycle, context) {
        val observer = LifecycleEventObserver { _, _ ->
            resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
        val motion = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reducedMotion = !personaAnimationsEnabled(context)
            }
        }
        lifecycle.addObserver(observer)
        context.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, motion)
        onDispose {
            lifecycle.removeObserver(observer)
            context.contentResolver.unregisterContentObserver(motion)
        }
    }
    val state = rememberPersonaState(ui)
    val original = remember(context) { runCatching { context.resources.openRawResource(R.raw.persona_halo).use { it.readBytes() } } }
    var appliedTuning by remember { mutableStateOf(tuning) }
    LaunchedEffect(tuning) {
        // A slider drag must not allocate a native renderer for each intermediate input event.
        delay(100)
        appliedTuning = tuning
    }
    val source = remember(original, appliedTuning) { original.mapCatching { compactHaloBytes(it, appliedTuning) } }
    val bytes = source.getOrNull()
    if (bytes == null) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text("Persona unavailable.", color = LocalPreviewTheme.current.palette.text, fontFamily = VoiceInk.type)
        }
        return
    }
    val animate = resumed && !reducedMotion
    // One shared size; state changes are entirely inside the modified animation.
    val targetScale = (if (ui.connected) 1.9f else 1.5f) * placement.speakingScale
    val scale = remember { Animatable(targetScale) }
    LaunchedEffect(targetScale, animate) {
        if (animate) scale.animateTo(targetScale, tween(300, easing = FastOutSlowInEasing))
        else scale.snapTo(targetScale)
    }
    BoxWithConstraints(modifier.clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        val diameter = minOf(maxWidth, maxHeight)
        // State and color updates retain this native instance; only a new source replaces it.
        key(bytes) {
            AndroidView(
                factory = { viewContext ->
                    Rive.init(viewContext)
                    (LayoutInflater.from(viewContext).inflate(R.layout.persona_halo_contained, null, false) as CompactHaloAnimationView)
                        .also { it.loadSource(bytes) }
                },
                modifier = Modifier.size(diameter).graphicsLayer {
                    scaleX = scale.value
                    scaleY = scale.value
                    translationY = placement.offsetY.toPx()
                },
                update = { it.present(state, colors.forState(state), animate) },
                onRelease = { it.pause() },
            )
        }
    }
}

/** Native Contained Rive host; source loading and pointer behavior are fixed by its local XML. */
class CompactHaloAnimationView(context: Context, attrs: AttributeSet? = null) : RiveAnimationView(context, attrs) {
    private val revision = AtomicInteger(0)
    @Volatile private var motion = false
    @Volatile private var presentation: Triple<PersonaState, Int, Boolean>? = null
    @Volatile private var listeningAnimation = "listening_off"
    private var loaded = false
    private val listener = object : RiveFileController.Listener {
        override fun notifyPlay(animation: PlayableInstance) { }
        override fun notifyPause(animation: PlayableInstance) { }
        override fun notifyStop(animation: PlayableInstance) { }
        override fun notifyLoop(animation: PlayableInstance) { }
        override fun notifyAdvance(elapsed: Float) { }
        override fun notifyStateChanged(stateMachineName: String, stateName: String) {
            if (stateMachineName == "default" && stateName in listOf("listening_in", "listening_loop", "listening_out", "listening_off")) {
                listeningAnimation = stateName
            }
        }
    }

    init { isOpaque = false }

    internal fun loadSource(bytes: ByteArray) {
        check(!loaded) { "A native Halo view owns one source." }
        setRiveBytes(bytes, stateMachineName = "default", autoBind = true, autoplay = false, fit = Fit.CONTAIN)
        setVolume(0f)
        controller.registerListener(listener)
        loaded = true
    }

    internal fun present(state: PersonaState, color: Int, animate: Boolean) {
        val next = Triple(state, color, animate)
        val previous = presentation
        if (previous == next) return
        check(loaded)
        presentation = next
        if (previous != null && previous.first == state && previous.third == animate) {
            stateMachines.single().viewModelInstance!!.getColorProperty("color").value = color
            // Recolor a frozen pose at zero elapsed time; only state/motion changes need settling.
            if (!animate || !isPlaying) play(settleInitialState = false)
            return
        }
        motion = animate
        revision.incrementAndGet()
        setBooleanState("default", "listening", state == PersonaState.Listening)
        setBooleanState("default", "speaking", state == PersonaState.Speaking)
        setBooleanState("default", "thinking", state == PersonaState.Thinking)
        setBooleanState("default", "asleep", false)
        stateMachines.single().viewModelInstance!!.getColorProperty("color").value = color
        play()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean = false
    override fun onHoverEvent(event: MotionEvent): Boolean = false

    override fun createRenderer(): Renderer = object : RiveArtboardRenderer(controller = controller) {
        private var observedRevision = -1
        override fun advance(elapsed: Float) {
            val selected = revision.get()
            val firstFrame = observedRevision == -1
            val changed = selected != observedRevision
            if (changed) observedRevision = selected
            if (changed && (firstFrame || !motion)) {
                // Settle before drawing a first/still pose, including a pending listening loop exit.
                for (frame in 0 until 480) {
                    super.advance(1f / 60f)
                    val settled = listeningAnimation == if (presentation?.first == PersonaState.Listening) "listening_loop" else "listening_off"
                    if (frame >= 60 && settled) break
                }
            } else super.advance(if (motion) elapsed.coerceAtMost(.05f) else 0f)
            if (!motion) controller.pause()
        }
    }
}
