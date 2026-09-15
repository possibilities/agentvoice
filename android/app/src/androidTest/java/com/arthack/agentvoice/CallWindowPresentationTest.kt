package com.arthack.agentvoice

import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CallWindowPresentationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun revealedSystemBarsKeepTheImmersiveSceneGeometry() {
        compose.activityRule.scenario.onActivity { it.enableEdgeToEdge() }
        compose.setContent {
            CallWindowPresentation(compose.activity.window, inPersona = true, running = true)
            VoiceTheme {
                VoiceScreen(CallUi(running = true, connected = true), {}, {}, {}, {})
            }
        }
        fun barsVisible(): Boolean {
            val insets = ViewCompat.getRootWindowInsets(compose.activity.window.decorView) ?: return true
            return insets.isVisible(WindowInsetsCompat.Type.statusBars()) ||
                insets.isVisible(WindowInsetsCompat.Type.navigationBars())
        }
        val tags = listOf("studio-persona-stage", "preview-controls", "mic-mute", "speaker-mute", "hold-to-talk")
        fun bounds() = tags.map { compose.onNodeWithTag(it, useUnmergedTree = true).getUnclippedBoundsInRoot() }
        compose.waitUntil(5_000) { !barsVisible() }
        val before = bounds()
        repeat(2) {
            compose.runOnIdle {
                WindowCompat.getInsetsController(compose.activity.window, compose.activity.window.decorView)
                    .show(WindowInsetsCompat.Type.systemBars())
            }
            compose.waitUntil(5_000) { barsVisible() }
            android.os.SystemClock.sleep(500)
            assertEquals("System bars must not squeeze the trace corridor", before, bounds())
            compose.runOnIdle {
                WindowCompat.getInsetsController(compose.activity.window, compose.activity.window.decorView)
                    .hide(WindowInsetsCompat.Type.systemBars())
            }
            compose.waitUntil(5_000) { !barsVisible() }
            android.os.SystemClock.sleep(500)
            assertEquals(before, bounds())
        }
    }

    @Test fun transportFailureKeepsTheViewportAndDeckWhileReleasingScreenAwake() {
        var running by mutableStateOf(true)
        var connected by mutableStateOf(true)
        var inPersona by mutableStateOf(true)
        var fontScale by mutableFloatStateOf(1f)
        compose.activityRule.scenario.onActivity { it.enableEdgeToEdge() }
        compose.setContent {
            CallWindowPresentation(compose.activity.window, inPersona, running)
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                VoiceTheme {
                    VoiceScreen(CallUi(running = running, connected = connected), {}, {}, {}, {}, connect = {})
                }
            }
        }
        fun barsVisible(): Boolean {
            val insets = ViewCompat.getRootWindowInsets(compose.activity.window.decorView) ?: return true
            return insets.isVisible(WindowInsetsCompat.Type.statusBars()) ||
                insets.isVisible(WindowInsetsCompat.Type.navigationBars())
        }
        fun screenAwake(): Boolean = compose.activity.window.attributes.flags and
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
        val tags = listOf("studio-persona-stage", "preview-controls", "mic-mute", "speaker-mute", "hold-to-talk")
        fun bounds() = tags.map { compose.onNodeWithTag(it, useUnmergedTree = true).getUnclippedBoundsInRoot() }
        compose.waitUntil(5_000) { !barsVisible() }
        for (scale in listOf(1f, 1.5f, 2f)) {
            compose.runOnIdle { fontScale = scale; running = true; connected = true }
            val before = bounds()
            compose.runOnIdle { assertTrue(screenAwake()); connected = false }
            assertEquals(before, bounds()) // Connecting/unavailable while the attempt still runs.
            compose.runOnIdle { running = false }
            compose.waitForIdle()
            // Wait beyond Android's system-bar animation: the old policy shrank the viewport here.
            android.os.SystemClock.sleep(500)
            compose.runOnIdle { assertFalse(screenAwake()); assertFalse(barsVisible()) }
            assertEquals(before, bounds())
            compose.onNodeWithTag("preview-connection-notice", useUnmergedTree = true).assertExists()
        }
        compose.runOnIdle { inPersona = false }
        compose.waitUntil(5_000) { barsVisible() }
        compose.runOnIdle { assertFalse(screenAwake()); running = true }
        compose.runOnIdle { assertFalse(screenAwake()) }
    }
}
