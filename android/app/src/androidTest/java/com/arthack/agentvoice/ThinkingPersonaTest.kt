@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.descendants
import app.rive.runtime.kotlin.RiveAnimationView
import app.rive.runtime.kotlin.core.SMIBoolean
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ThinkingPersonaTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @Test fun originalReflectsCodingWorkAndRetainsItsNativeInstance() = verifyThinking(false)
    @Test fun containedReflectsCodingWorkAndRetainsItsNativeInstance() = verifyThinking(true)

    private fun verifyThinking(contained: Boolean) {
        val working = CallUi(connected = true, micOpen = true, speakerOpen = true, codingActivity = CodingActivity.Working)
        var ui by mutableStateOf(working)
        compose.setContent {
            VoiceTheme {
                if (contained) CompactPersonaHalo(ui, Modifier.size(260.dp), PersonaPlacement(), CompactHaloTuning())
                else PersonaHalo(ui, Modifier.size(260.dp))
            }
        }
        val view = compose.runOnIdle {
            (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single()
        }
        val machine = compose.runOnIdle { view.stateMachines.single() }
        fun selected(input: String) = compose.runOnIdle { (machine.input(input) as SMIBoolean).value }
        fun expectInput(input: String?) {
            compose.waitUntil(5000) {
                listOf("speaking", "listening", "thinking").all { selected(it) == (it == input) }
            }
        }
        fun pixels(): IntArray? = compose.runOnIdle {
            view.getBitmap(160, 160)?.let { bitmap ->
                IntArray(160 * 160).also { bitmap.getPixels(it, 0, 160, 0, 0, 160, 160); bitmap.recycle() }
            }
        }
        expectInput("thinking")
        compose.waitUntil(5000) { pixels()?.any { (it ushr 24) > 20 } == true }
        val first = pixels()!!
        compose.waitUntil(3000) { !first.contentEquals(pixels()) }
        compose.runOnIdle { ui = working.copy(outputLevel = .2f) }
        expectInput("speaking")
        compose.runOnIdle { ui = working }
        expectInput("thinking")
        compose.runOnIdle { ui = working.copy(holding = true) }
        expectInput("listening")
        compose.runOnIdle { ui = working }
        expectInput("thinking")
        for (activity in listOf(CodingActivity.Blocked, CodingActivity.Idle, CodingActivity.Unknown)) {
            compose.runOnIdle { ui = working.copy(codingActivity = activity, micOpen = false) }
            expectInput(null)
        }
        compose.runOnIdle { ui = working.copy(connected = false) }
        expectInput(null)
        compose.runOnIdle {
            assertSame(machine, view.stateMachines.single())
            assertSame(view, (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single())
        }
    }
}
