@file:Suppress("DEPRECATION")

package com.arthack.agentvoice

import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.descendants
import androidx.test.platform.app.InstrumentationRegistry
import app.rive.runtime.kotlin.RiveAnimationView
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class OriginalPersonaPlacementTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun assertScale(expected: Float, actual: Float?) {
        assertNotNull(actual)
        assertEquals(expected, actual!!, .015f)
    }

    @Test fun observationTracksSettledAndInterruptedOriginalPlacementWithoutReplacingTheView() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val setting = Settings.Global.ANIMATOR_DURATION_SCALE
        val originalDurationScale = Settings.Global.getString(instrumentation.targetContext.contentResolver, setting)
        require(originalDurationScale == null || originalDurationScale.toFloatOrNull() != null)
        fun animationSetting(command: String) {
            instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
                ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
            }
        }

        val displayed = PersonaDisplayedPlacement()
        var ui by mutableStateOf(CallUi(running = true, connected = true))
        var placement by mutableStateOf(PersonaPlacement(speakingScale = 1f, listeningScale = .35f, idleScale = .6f))
        var show by mutableStateOf(true)
        try {
            animationSetting("settings put global $setting 1")
            compose.setContent {
                VoiceTheme {
                    Box(Modifier.size(260.dp)) {
                        if (show) PersonaHalo(ui, Modifier.size(260.dp), placement, displayedPlacement = displayed)
                    }
                }
            }
            compose.waitUntil(5000) { displayed.scale?.let { kotlin.math.abs(it - .6f * 1.9f) < .015f } == true }
            val view = compose.runOnIdle {
                (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<RiveAnimationView>().single()
            }
            assertScale(.6f * 1.9f, displayed.scale)

            compose.runOnIdle { ui = ui.copy(micOpen = true) }
            compose.waitUntil(3000) {
                displayed.scale?.let { it < .6f * 1.9f - .03f && it > .35f * 1.9f + .03f } == true
            }
            compose.runOnIdle { assertSame(view, nativeView()); placement = placement.copy(listeningScale = .45f) }
            compose.waitUntil(3000) { displayed.scale?.let { kotlin.math.abs(it - .45f * 1.9f) < .015f } == true }
            assertScale(.45f * 1.9f, displayed.scale)

            compose.runOnIdle { ui = ui.copy(micOpen = false, speakerOpen = true, outputLevel = .2f) }
            compose.waitUntil(5000) {
                displayed.scale?.let { it > .45f * 1.9f + .04f && it < .78f * 1.9f } == true
            }
            compose.runOnIdle { placement = placement.copy(speakingScale = .85f) }
            compose.waitUntil(3000) { displayed.scale?.let { kotlin.math.abs(it - .85f * 1.9f) < .015f } == true }
            assertScale(.85f * 1.9f, displayed.scale)
            compose.runOnIdle { assertSame(view, nativeView()) }

            animationSetting("settings put global $setting 0")
            compose.waitUntil(3000) { !view.isPlaying }
            compose.runOnIdle {
                ui = CallUi(running = true, connected = true)
                placement = placement.copy(idleScale = .52f)
            }
            compose.waitUntil(3000) { displayed.scale?.let { kotlin.math.abs(it - .52f * 1.9f) < .015f } == true }
            assertScale(.52f * 1.9f, displayed.scale)
            compose.runOnIdle { assertSame(view, nativeView()); show = false }
            compose.waitForIdle()
            compose.runOnIdle {
                assertNull(displayed.scale)
                assertTrue((compose.activity.window.decorView as ViewGroup).descendants
                    .filterIsInstance<RiveAnimationView>().none())
            }
        } finally {
            animationSetting(if (originalDurationScale == null) "settings delete global $setting"
                else "settings put global $setting $originalDurationScale")
        }
    }

    private fun nativeView() = (compose.activity.window.decorView as ViewGroup).descendants
        .filterIsInstance<RiveAnimationView>().single()
}
