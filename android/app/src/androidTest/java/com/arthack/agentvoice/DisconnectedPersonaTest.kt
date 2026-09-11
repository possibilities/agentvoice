@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.view.ViewGroup
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.unit.dp
import androidx.core.view.descendants
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.platform.app.InstrumentationRegistry
import app.rive.runtime.kotlin.RiveAnimationView
import app.rive.runtime.kotlin.core.SMIBoolean
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class DisconnectedPersonaTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun originalDisconnectedPresenceMovesAndPausesWithVisibility() = verifyPresence(false)
    @Test fun containedDisconnectedPresenceMovesAndPausesWithVisibility() = verifyPresence(true)

    private fun verifyPresence(contained: Boolean) {
        var ui by mutableStateOf(CallUi())
        val owner = object : LifecycleOwner {
            val registry = LifecycleRegistry(this)
            override val lifecycle: Lifecycle get() = registry
        }
        compose.runOnUiThread { owner.registry.currentState = Lifecycle.State.RESUMED }
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                VoiceTheme {
                    Box(Modifier.size(260.dp)) {
                        if (contained) CompactPersonaHalo(ui, Modifier.size(260.dp), PersonaPlacement(offsetY = 0.dp), CompactHaloTuning())
                        else PersonaHalo(ui, Modifier.size(260.dp), PersonaPlacement(offsetY = 0.dp))
                    }
                }
            }
        }
        val view = compose.runOnIdle {
            (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single()
        }
        fun pixels(): IntArray? = compose.runOnIdle {
            view.getBitmap(160, 160)?.let { bitmap ->
                IntArray(160 * 160).also { values ->
                    bitmap.getPixels(values, 0, 160, 0, 0, 160, 160)
                    bitmap.recycle()
                }
            }
        }
        fun assertMoving() {
            compose.waitUntil(5000) { pixels()?.any { (it ushr 24) > 20 } == true }
            val first = pixels()!!
            compose.waitUntil(3000) { !first.contentEquals(pixels()) }
            compose.runOnIdle {
                assertTrue(view.isPlaying)
                val machine = view.stateMachines.single()
                for (input in listOf("speaking", "listening", "thinking", "asleep"))
                    assertFalse(input, (machine.input(input) as SMIBoolean).value)
            }
        }
        assertMoving()
        val machine = compose.runOnIdle { view.stateMachines.single() }
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.STARTED }
        compose.waitUntil(3000) { !view.isPlaying }
        // Renderer pause precedes the GPU's final presented frame.
        Thread.sleep(150)
        val paused = pixels()!!
        Thread.sleep(200)
        assertArrayEquals("Hidden disconnected presence must stay still", paused, pixels())
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        assertMoving()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val setting = Settings.Global.ANIMATOR_DURATION_SCALE
        val originalScale = Settings.Global.getString(instrumentation.targetContext.contentResolver, setting)
        require(originalScale == null || originalScale.toFloatOrNull() != null)
        fun animationSetting(command: String) {
            instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
                android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
            }
        }
        try {
            animationSetting("settings put global $setting 0")
            compose.waitUntil(3000) { !view.isPlaying }
            Thread.sleep(150)
            val reduced = pixels()!!
            Thread.sleep(200)
            assertArrayEquals("Disabled system animations must stop disconnected motion", reduced, pixels())
            fun visibleRingBounds(): List<Int> {
                val image = compose.onRoot().captureToImage().toPixelMap()
                var left = image.width; var top = image.height; var right = -1; var bottom = -1
                for (y in 0 until image.height) for (x in 0 until image.width) {
                    val color = image[x, y]
                    if (maxOf(color.red, color.green, color.blue) > .3f) {
                        left = minOf(left, x); top = minOf(top, y)
                        right = maxOf(right, x); bottom = maxOf(bottom, y)
                    }
                }
                assertTrue("Visible ring required", right > left && bottom > top)
                return listOf(left, top, right, bottom)
            }
            val disconnectedBounds = visibleRingBounds()
            compose.runOnIdle { ui = CallUi(running = true, connected = true) }
            compose.waitForIdle()
            Thread.sleep(150)
            val idleBounds = visibleRingBounds()
            // State presentation can advance one authored pose even while motion is disabled.
            // The old 1.5/1.9 shrink exceeds this allowance in both dimensions.
            for ((start, end) in listOf(0 to 2, 1 to 3)) {
                val before = disconnectedBounds[end] - disconnectedBounds[start]
                val after = idleBounds[end] - idleBounds[start]
                assertTrue("Connection must retain Idle ring size: $disconnectedBounds vs $idleBounds",
                    kotlin.math.abs(before - after).toFloat() / after <= .08f)
            }
            compose.runOnIdle { ui = CallUi() }
            compose.waitForIdle()
        } finally {
            animationSetting(if (originalScale == null) "settings delete global $setting"
                else "settings put global $setting $originalScale")
        }
        assertMoving()
        compose.runOnIdle { ui = CallUi(running = true, connected = true) }
        compose.waitForIdle()
        compose.runOnIdle { ui = CallUi() }
        assertMoving()
        compose.runOnIdle {
            assertSame(machine, view.stateMachines.single())
            assertSame(view, (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single())
            owner.registry.currentState = Lifecycle.State.DESTROYED
        }
    }
}
