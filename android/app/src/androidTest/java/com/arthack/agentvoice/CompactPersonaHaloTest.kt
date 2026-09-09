@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.graphics.Bitmap
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.descendants
import androidx.test.platform.app.InstrumentationRegistry
import app.rive.runtime.kotlin.RiveAnimationView
import app.rive.runtime.kotlin.core.Rive
import app.rive.runtime.kotlin.core.SMIBoolean
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CompactPersonaHaloTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun source(): ByteArray = InstrumentationRegistry.getInstrumentation().targetContext.resources
        .openRawResource(R.raw.persona_halo).use { it.readBytes() }

    private fun pixels(view: RiveAnimationView): IntArray? = compose.runOnIdle {
        view.getBitmap(256, 256)?.let { bitmap ->
            IntArray(256 * 256).also { bitmap.getPixels(it, 0, 256, 0, 0, 256, 256); bitmap.recycle() }
        }
    }

    private fun diameter(pixels: IntArray): Int {
        val indices = pixels.indices.filter { (pixels[it] ushr 24) >= 40 }
        if (indices.isEmpty()) return 0
        return maxOf(indices.maxOf { it % 256 } - indices.minOf { it % 256 },
            indices.maxOf { it / 256 } - indices.minOf { it / 256 }) + 1
    }

    private fun saveEvidence(name: String, view: RiveAnimationView) = compose.runOnIdle {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "contained-halo-test").also { it.mkdirs() }
        view.getBitmap(512, 512)?.let { bitmap ->
            File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    @Test fun containedListeningHasSmallerBoundsAndSameStateContract() {
        lateinit var original: HaloAnimationView
        lateinit var contained: CompactHaloAnimationView
        val bytes = compactHaloBytes(source(), CompactHaloTuning())
        compose.setContent {
            VoiceTheme {
                Column(Modifier.fillMaxSize().background(VoiceInk.ground), horizontalAlignment = Alignment.CenterHorizontally) {
                    AndroidView(factory = { context ->
                        Rive.init(context)
                        (LayoutInflater.from(context).inflate(R.layout.persona_halo, null, false) as HaloAnimationView).also { original = it }
                    }, modifier = Modifier.size(240.dp), update = { it.present(PersonaState.Listening, VoiceInk.you.toArgb(), false) },
                        onRelease = { it.pause() })
                    AndroidView(factory = { context ->
                        (LayoutInflater.from(context).inflate(R.layout.persona_halo_contained, null, false) as CompactHaloAnimationView)
                            .also { it.loadSource(bytes); contained = it }
                    }, modifier = Modifier.size(240.dp), update = { it.present(PersonaState.Listening, VoiceInk.you.toArgb(), false) },
                        onRelease = { it.pause() })
                }
            }
        }
        compose.waitForIdle()
        compose.waitUntil(5000) { pixels(original)?.let(::diameter)?.let { it > 100 } == true &&
            pixels(contained)?.let(::diameter)?.let { it > 100 } == true }
        compose.waitUntil(3000) { !original.isPlaying && !contained.isPlaying }
        Thread.sleep(150)
        val originalDiameter = diameter(pixels(original)!!)
        val containedDiameter = diameter(pixels(contained)!!)
        assertTrue("Original listening=$originalDiameter, contained=$containedDiameter", containedDiameter < originalDiameter * .8)
        assertTrue("Contained ring must remain visible", containedDiameter > 100)
        compose.runOnIdle {
            val machine = contained.stateMachines.single()
            assertTrue((machine.input("listening") as SMIBoolean).value)
            assertFalse((machine.input("speaking") as SMIBoolean).value)
            assertFalse((machine.input("thinking") as SMIBoolean).value)
            assertEquals(VoiceInk.you.toArgb(), machine.viewModelInstance!!.getColorProperty("color").value)
        }
        saveEvidence("original-listening", original)
        saveEvidence("contained-listening", contained)
        val still = pixels(contained)!!
        Thread.sleep(250)
        assertArrayEquals("Reduced-motion frame must remain still", still, pixels(contained))
    }

    @Test fun stateAndColorChangesKeepTheNativeInstance() {
        val idle = CallUi(running = true, connected = true, speakerOpen = true)
        var ui by mutableStateOf(idle)
        var colors by mutableStateOf(CompactHaloColors())
        compose.setContent {
            VoiceTheme {
                Box(Modifier.fillMaxSize().background(VoiceInk.ground), contentAlignment = Alignment.Center) {
                    CompactPersonaHalo(ui, Modifier.size(240.dp), PersonaPlacement(.65f, .65f, .65f), CompactHaloTuning(), colors)
                }
            }
        }
        val view = compose.runOnIdle {
            (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<CompactHaloAnimationView>().single()
        }
        compose.waitUntil(5000) { pixels(view)?.let(::diameter)?.let { it > 100 } == true }
        for (next in listOf(idle.copy(micOpen = true), idle.copy(outputLevel = .15f), idle.copy(micOpen = true), idle)) {
            compose.runOnIdle { ui = next }
            compose.mainClock.advanceTimeBy(220)
        }
        compose.runOnIdle { ui = idle.copy(outputLevel = .15f); colors = colors.copy(speaking = 0xFF71E5C0.toInt()) }
        compose.waitUntil(3000) {
            compose.runOnIdle { (view.stateMachines.single().input("speaking") as SMIBoolean).value }
        }
        compose.runOnIdle {
            assertSame(view, (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<CompactHaloAnimationView>().single())
            assertEquals(0xFF71E5C0.toInt(), view.stateMachines.single().viewModelInstance!!.getColorProperty("color").value)
        }
        val first = pixels(view)!!
        compose.waitUntil(3000) { !first.contentEquals(pixels(view)) }
    }
}
