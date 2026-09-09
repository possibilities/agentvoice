@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.descendants
import app.rive.runtime.kotlin.core.Rive
import app.rive.runtime.kotlin.core.SMIBoolean
import app.rive.runtime.kotlin.core.PlayableInstance
import app.rive.runtime.kotlin.controllers.RiveFileController
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PersonaHaloTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun setHaloContent(content: @Composable () -> Unit) {
        compose.setContent {
            VoiceTheme {
                Box(Modifier.fillMaxSize().background(VoiceInk.ground), contentAlignment = Alignment.Center) { content() }
            }
        }
    }

    @Test fun listeningEntryWaitsForShrinkingAndCanBeCancelled() {
        val frames = AtomicInteger(0)
        val entered = AtomicBoolean(false)
        val idle = CallUi(running = true, connected = true, speakerOpen = true)
        var ui by mutableStateOf(idle)
        val listener = object : RiveFileController.Listener {
            override fun notifyPlay(animation: PlayableInstance) { }
            override fun notifyPause(animation: PlayableInstance) { }
            override fun notifyStop(animation: PlayableInstance) { }
            override fun notifyLoop(animation: PlayableInstance) { }
            override fun notifyAdvance(elapsed: Float) { frames.incrementAndGet() }
            override fun notifyStateChanged(stateMachineName: String, stateName: String) {
                if (stateName == "listening_in") entered.set(true)
            }
        }
        setHaloContent {
            PersonaHalo(ui, Modifier.size(260.dp), PersonaPlacement(speakingScale = .78f, listeningScale = .58f, idleScale = .78f))
        }
        val view = compose.runOnIdle {
            (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<HaloAnimationView>().single().also {
                it.controller.registerListener(listener)
            }
        }
        fun renderedFrames() {
            val before = frames.get()
            compose.waitUntil(3000) { frames.get() >= before + 3 }
        }
        fun listening(): Boolean = compose.runOnIdle {
            (view.stateMachines.single().input("listening") as SMIBoolean).value
        }
        renderedFrames()
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle { ui = idle.copy(micOpen = true) }
            compose.mainClock.advanceTimeBy(100)
            renderedFrames()
            assertFalse("Listening expanded while its larger idle scale was still shrinking", listening())
            compose.runOnIdle { ui = idle }
            compose.mainClock.advanceTimeBy(450)
            renderedFrames()
            assertFalse("A cancelled entry still triggered the native animation", entered.get())

            compose.runOnIdle { ui = idle.copy(micOpen = true) }
            compose.mainClock.advanceTimeBy(100)
            renderedFrames()
            assertFalse(listening())
            compose.mainClock.advanceTimeBy(350)
            compose.waitUntil(3000) { listening() }
        } finally {
            compose.mainClock.autoAdvance = true
            compose.runOnIdle { view.controller.unregisterListener(listener) }
        }
    }

    @Test fun idleEnlargementOverlapsTheAuthoredListeningExit() {
        val events = ConcurrentLinkedQueue<String>()
        val durations = mutableMapOf<String, Float>()
        val startedAt = System.nanoTime()
        val exiting = AtomicBoolean(false)
        val exited = AtomicBoolean(false)
        val growthDuration = AtomicInteger(0)
        val settledDuration = AtomicInteger(0)
        val premature = AtomicBoolean(false)
        var state by mutableStateOf(PersonaState.Listening)
        val listener = object : RiveFileController.Listener {
            override fun notifyPlay(animation: PlayableInstance) { }
            override fun notifyPause(animation: PlayableInstance) { }
            override fun notifyStop(animation: PlayableInstance) { }
            override fun notifyLoop(animation: PlayableInstance) { }
            override fun notifyAdvance(elapsed: Float) { }
            override fun notifyStateChanged(stateMachineName: String, stateName: String) {
                events.add("$stateName at ${(System.nanoTime() - startedAt) / 1_000_000} ms")
                if (stateName == "listening_out") exiting.set(true)
                if (stateName == "listening_off") exited.set(true)
            }
        }
        setHaloContent {
            AndroidView(factory = { context ->
                Rive.init(context)
                (LayoutInflater.from(context).inflate(R.layout.persona_halo, null, false) as HaloAnimationView).also {
                    it.controller.registerListener(listener)
                    for (name in listOf("listening_in", "listening_loop", "listening_out", "listening_off")) {
                        val animation = it.controller.activeArtboard!!.animation(name)
                        durations[name] = animation.effectiveDurationInSeconds
                    }
                }
            }, modifier = Modifier.size(260.dp), update = { view ->
                view.onGrowthReady = if (state == PersonaState.Listening) null else ({ duration ->
                    if (growthDuration.compareAndSet(0, duration)) {
                        if (!exiting.get() || exited.get()) premature.set(true)
                    } else settledDuration.set(duration)
                })
                view.present(state, 0xFFD4FF72.toInt(), true)
            }, onRelease = { it.onGrowthReady = null; it.controller.unregisterListener(listener); it.pause() })
        }
        compose.waitUntil(5000) { events.any { it.contains("listening_loop") } }
        compose.runOnIdle { exited.set(false); state = PersonaState.Idle }
        compose.waitUntil(6000) { growthDuration.get() > 0 }
        assertFalse("Growth must begin during listening_out; states: $events; durations: $durations", premature.get())
        assertEquals("Growth should span the authored exit", (durations.getValue("listening_out") * 1000).toInt(), growthDuration.get())
        compose.waitUntil(3000) { settledDuration.get() > 0 }
        assertTrue(exited.get())
        assertEquals("Later slider adjustments should use ordinary timing", 300, settledDuration.get())
    }

    @Test fun speakingEnlargementWaitsForTheListeningRingsToCollapse() {
        val events = ConcurrentLinkedQueue<String>()
        val listening = AtomicBoolean(false)
        val exiting = AtomicBoolean(false)
        val exited = AtomicBoolean(false)
        val growthDuration = AtomicInteger(0)
        val premature = AtomicBoolean(false)
        var view: HaloAnimationView? = null
        var state by mutableStateOf(PersonaState.Listening)
        val listener = object : RiveFileController.Listener {
            override fun notifyPlay(animation: PlayableInstance) { }
            override fun notifyPause(animation: PlayableInstance) { }
            override fun notifyStop(animation: PlayableInstance) { }
            override fun notifyLoop(animation: PlayableInstance) { }
            override fun notifyAdvance(elapsed: Float) { }
            override fun notifyStateChanged(stateMachineName: String, stateName: String) {
                events.add(stateName)
                if (stateName == "listening_loop") listening.set(true)
                if (stateName == "listening_out") exiting.set(true)
                if (stateName == "listening_off") exited.set(true)
            }
        }
        setHaloContent {
            AndroidView(factory = { context ->
                Rive.init(context)
                (LayoutInflater.from(context).inflate(R.layout.persona_halo, null, false) as HaloAnimationView).also {
                    view = it
                    it.controller.registerListener(listener)
                }
            }, modifier = Modifier.size(260.dp), update = { halo ->
                halo.onGrowthReady = if (state != PersonaState.Speaking) null else ({ duration ->
                    if (!exited.get()) premature.set(true)
                    growthDuration.compareAndSet(0, duration)
                })
                halo.present(state, 0xFFBBAAFF.toInt(), true)
            }, onRelease = { it.onGrowthReady = null; it.controller.unregisterListener(listener); it.pause() })
        }
        compose.waitUntil(5000) { listening.get() }
        compose.runOnIdle { exited.set(false); state = PersonaState.Speaking }
        compose.waitUntil(6000) { exiting.get() }
        compose.runOnIdle {
            assertTrue("Speaking itself should remain responsive", (view!!.stateMachines.single().input("speaking") as SMIBoolean).value)
        }
        compose.waitUntil(3000) { growthDuration.get() > 0 }
        assertFalse("Speaking enlarged the outgoing listening rings; states: $events", premature.get())
        assertTrue("Speaking growth must wait for listening_off; states: $events", exited.get())
        assertEquals(300, growthDuration.get())
    }

    @Test fun bundledAssetRendersAnimatesAndFreezesWithoutMedia() {
        var view: HaloAnimationView? = null
        var animate by mutableStateOf(true)
        var state by mutableStateOf(PersonaState.Speaking)
        setHaloContent {
            AndroidView(factory = { context ->
                Rive.init(context)
                (LayoutInflater.from(context).inflate(R.layout.persona_halo, null, false) as HaloAnimationView).also { view = it }
            }, modifier = Modifier.size(260.dp),
                update = { it.present(state, 0xFFBBAAFF.toInt(), animate) },
                onRelease = { it.pause() })
        }
        fun pixels(): IntArray? = compose.runOnIdle {
            view?.getBitmap(120, 120)?.let { bitmap ->
                IntArray(120 * 120).also { bitmap.getPixels(it, 0, 120, 0, 0, 120, 120); bitmap.recycle() }
            }
        }
        compose.waitUntil(5000) { pixels()?.any { (it ushr 24) > 20 } == true }
        compose.runOnIdle {
            val machine = view!!.stateMachines.single()
            assertTrue((machine.input("speaking") as SMIBoolean).value)
            assertFalse((machine.input("thinking") as SMIBoolean).value)
            assertEquals(0xFFBBAAFF.toInt(), machine.viewModelInstance!!.getColorProperty("color").value)
        }
        val moving = pixels()!!
        compose.waitUntil(3000) { !pixels().contentEquals(moving) }
        compose.runOnIdle { animate = false; state = PersonaState.Listening }
        compose.waitUntil(3000) { compose.runOnIdle { view?.isPlaying == false } }
        // Wait for the GPU's final presented frame, then verify a real stationary texture.
        Thread.sleep(150)
        val still = pixels()!!
        Thread.sleep(300)
        assertArrayEquals(still, pixels())
        compose.runOnIdle {
            assertTrue((view!!.stateMachines.single().input("listening") as SMIBoolean).value)
            assertFalse((view!!.stateMachines.single().input("speaking") as SMIBoolean).value)
        }
    }
}
