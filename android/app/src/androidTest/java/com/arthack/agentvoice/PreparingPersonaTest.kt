@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.descendants
import app.rive.runtime.kotlin.RiveAnimationView
import app.rive.runtime.kotlin.core.SMIBoolean
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Synthetic shared scene only: no call, credentials, microphone or network. */
class PreparingPersonaTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @Test fun originalPreparationIsLitAndStillWithoutReplacingTheRenderer() = verify("original")
    @Test fun containedPreparationIsLitAndStillWithoutReplacingTheRenderer() = verify("contained")

    private fun verify(variant: String) {
        var connection by mutableStateOf("connecting")
        var ui by mutableStateOf(CallUi(running = true))
        compose.setContent {
            VoiceTheme {
                PreviewStudioScreen(ui, PreviewDesign(), PersonaPlacement(), {}, {}, {}, {},
                    connection = connection, halo = PreviewHalo(variant = variant))
            }
        }
        val view = compose.runOnIdle {
            (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single()
        }
        compose.waitUntil(5000) { compose.runOnIdle { !view.isPlaying && view.getBitmap(120, 120)?.let {
            val pixels = IntArray(120 * 120)
            it.getPixels(pixels, 0, 120, 0, 0, 120, 120); it.recycle()
            pixels.any { color -> color ushr 24 > 20 }
        } == true } }
        val machine = compose.runOnIdle { view.stateMachines.single() }
        compose.runOnIdle {
            assertEquals(VoiceInk.text.toArgb(), machine.viewModelInstance!!.getColorProperty("color").value)
            for (input in listOf("speaking", "listening", "thinking", "asleep"))
                assertFalse(input, (machine.input(input) as SMIBoolean).value)
            assertFalse(ui.connected); assertFalse(ui.canHold)
            connection = "failed"
            ui = CallUi(message = "Synthetic failure")
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(VoiceInk.muted.toArgb(), machine.viewModelInstance!!.getColorProperty("color").value)
            assertSame(machine, view.stateMachines.single())
            assertSame(view, (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single())
        }
    }
}
