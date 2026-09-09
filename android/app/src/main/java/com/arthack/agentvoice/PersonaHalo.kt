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
import androidx.annotation.AnyThread
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
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
import kotlinx.coroutines.delay
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

internal enum class PersonaState { Asleep, Idle, Listening, Speaking }

internal data class PersonaPlacement(
    val speakingScale: Float = .78f,
    val listeningScale: Float = .58f,
    val idleScale: Float = .78f,
) {
    // The operator's chosen vertical position stays fixed through every state.
    val offsetY: Dp get() = 35.dp

    fun scaleFor(state: PersonaState): Float = when (state) {
        PersonaState.Speaking -> speakingScale
        PersonaState.Listening -> listeningScale
        PersonaState.Idle, PersonaState.Asleep -> idleScale
    }
}

// No "thinking" state: the client has no reliable observation of agent cognition.
internal fun personaState(ui: CallUi): PersonaState = when {
    !ui.connected -> PersonaState.Asleep
    ui.speakerOpen && ui.outputLevel > .008f -> PersonaState.Speaking
    ui.micOpen -> PersonaState.Listening
    else -> PersonaState.Idle
}

@Composable
internal fun PersonaHalo(ui: CallUi, modifier: Modifier, placement: PersonaPlacement = PersonaPlacement()) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var reducedMotion by remember { mutableStateOf(!android.animation.ValueAnimator.areAnimatorsEnabled()) }
    DisposableEffect(lifecycle, context) {
        val observer = LifecycleEventObserver { _, _ ->
            resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
        val motion = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reducedMotion = !android.animation.ValueAnimator.areAnimatorsEnabled()
            }
        }
        lifecycle.addObserver(observer)
        context.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, motion)
        onDispose {
            lifecycle.removeObserver(observer)
            context.contentResolver.unregisterContentObserver(motion)
        }
    }
    val requested = personaState(ui)
    var state by remember { mutableStateOf(requested) }
    LaunchedEffect(requested, ui.connected, ui.speakerOpen) {
        // Bridge short silences between syllables; gate closure and disconnect remain immediate.
        if (state == PersonaState.Speaking && requested != PersonaState.Speaking && ui.connected && ui.speakerOpen) delay(180)
        state = requested
    }
    val ink = when (state) {
        PersonaState.Listening -> VoiceInk.you
        PersonaState.Speaking -> VoiceInk.agent
        PersonaState.Idle -> VoiceInk.text
        PersonaState.Asleep -> VoiceInk.muted
    }
    val artboardScale = if (ui.connected) 1.9f else 1.5f
    val targetScale = artboardScale * placement.scaleFor(state)
    val animate = ui.connected && resumed && !reducedMotion
    val scale = remember { Animatable(targetScale) }
    var renderedState by remember { mutableStateOf(state) }
    val growthDuration = remember(renderedState, animate) { mutableStateOf<Int?>(null) }
    val readyToGrow = renderedState == state && growthDuration.value != null
    LaunchedEffect(state, targetScale, animate, readyToGrow) {
        if (!animate) {
            scale.snapTo(targetScale)
            renderedState = state
        } else if (state == PersonaState.Listening && renderedState != state && targetScale < scale.value) {
            // Fit the incoming ripples before starting them; a cancelled entry never reaches Rive.
            scale.animateTo(targetScale, tween(durationMillis = 300, easing = FastOutSlowInEasing))
            renderedState = state
        } else {
            renderedState = state
            // Native listening exit timing governs when each destination may enlarge.
            if (targetScale <= scale.value || readyToGrow) {
                val duration = if (targetScale > scale.value) growthDuration.value!! else 300
                scale.animateTo(targetScale, tween(durationMillis = duration, easing = FastOutSlowInEasing))
            }
        }
    }
    // The screen places this behind every control; active ripples may cross its layout bounds.
    BoxWithConstraints(modifier.clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        val diameter = minOf(maxWidth, maxHeight)
        AndroidView(
            factory = { viewContext ->
                Rive.init(viewContext)
                LayoutInflater.from(viewContext).inflate(R.layout.persona_halo, null, false) as HaloAnimationView
            },
            // Reading scale in the layer avoids recomposing the native view on every frame.
            modifier = Modifier.size(diameter).graphicsLayer {
                scaleX = scale.value
                scaleY = scale.value
                translationY = placement.offsetY.toPx()
            },
            update = { view ->
                view.onGrowthReady = { growthDuration.value = it }
                view.present(renderedState, ink.toArgb(), animate)
            },
            onRelease = { view -> view.onGrowthReady = null; view.pause() },
        )
    }
}

/** The pinned Persona file uses legacy boolean inputs, absent from Rive's new Compose API. */
class HaloAnimationView(context: Context, attrs: AttributeSet? = null) : RiveAnimationView(context, attrs) {
    private val revision = AtomicInteger(0)
    @Volatile private var motion = false
    @Volatile private var presentation: Triple<PersonaState, Int, Boolean>? = null
    internal var onGrowthReady: ((Int) -> Unit)? = null
    @Volatile private var listeningAnimation = "listening_off"
    private val listeningExitDurationMillis: Int
    private val stateListener = object : RiveFileController.Listener {
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
    init {
        isOpaque = false
        setRiveResource(R.raw.persona_halo, stateMachineName = "default", autoBind = true, autoplay = false, fit = Fit.CONTAIN)
        setVolume(0f)
        controller.registerListener(stateListener)
        // Rive 11.12 owns this instance through the artboard's dependency list.
        val exit = controller.activeArtboard!!.animation("listening_out")
        listeningExitDurationMillis = (exit.effectiveDurationInSeconds * 1000).roundToInt()
    }
    @AnyThread private fun listeningSettled(): Boolean = listeningAnimation ==
        if (presentation?.first == PersonaState.Listening) "listening_loop" else "listening_off"
    internal fun present(state: PersonaState, color: Int, animate: Boolean) {
        val next = Triple(state, color, animate)
        if (presentation == next) return
        presentation = next
        motion = animate
        revision.incrementAndGet()
        setBooleanState("default", "listening", state == PersonaState.Listening)
        setBooleanState("default", "speaking", state == PersonaState.Speaking)
        setBooleanState("default", "thinking", false)
        // Keep the authored halo visible at rest; paused idle is our asleep presentation.
        setBooleanState("default", "asleep", false)
        stateMachines.first().viewModelInstance!!.getColorProperty("color").value = color
        play()
    }
    override fun onTouchEvent(event: MotionEvent): Boolean = false
    override fun onHoverEvent(event: MotionEvent): Boolean = false
    override fun createRenderer(): Renderer = object : RiveArtboardRenderer(controller = controller) {
        private var observedRevision = -1
        private var reportedGrowth = false
        private var reportedSettled = false
        private var exitElapsed = 0f
        override fun advance(elapsed: Float) {
            val selected = revision.get()
            val firstFrame = observedRevision == -1
            val changed = selected != observedRevision
            if (changed) {
                observedRevision = selected
                reportedGrowth = false
                reportedSettled = false
            }
            if (changed && (firstFrame || !motion)) {
                // Present a fully sized first pose; also settle reduced-motion updates before drawing.
                // Listening may finish its current loop before its exit animation begins.
                for (frame in 0 until 480) {
                    super.advance(1f / 60f)
                    if (frame >= 47 && listeningSettled()) break
                }
            } else if (motion) {
                val step = elapsed.coerceAtMost(.05f)
                val previous = listeningAnimation
                super.advance(step)
                exitElapsed = if (previous == "listening_out" && listeningAnimation == previous) exitElapsed + step else 0f
            } else super.advance(0f)
            if (!motion) controller.pause()
            val duration = when {
                // Speaking's own expansion needs the outgoing rings gone; only Idle overlaps growth.
                presentation?.first == PersonaState.Idle && listeningAnimation == "listening_out" ->
                    (listeningExitDurationMillis - (exitElapsed * 1000).roundToInt()).coerceAtLeast(1)
                listeningSettled() -> 300
                else -> null
            }
            val settled = listeningSettled()
            if (duration != null && (!reportedGrowth || settled && !reportedSettled)) {
                reportedGrowth = true
                reportedSettled = settled
                // Follow native exit timing; presentation changes cannot release an old growth hold.
                post { if (revision.get() == selected) onGrowthReady?.invoke(duration) }
            }
        }
    }
}
