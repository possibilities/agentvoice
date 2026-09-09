package com.arthack.agentvoice

import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewSpiritTest {
    @get:Rule val compose = createComposeRule()

    @Test fun sceneTicksRetainHeldPointerAndAllControlBounds() {
        var ui by mutableStateOf(CallUi(connected = true, micMuted = true, canHold = true))
        val light = mutableStateOf(PreviewButtonLight())
        var starts = 0
        var stops = 0
        compose.setContent {
            VoiceTheme {
                PreviewControls(ui, {}, {
                    starts++
                    ui = ui.copy(holding = true, micOpen = true)
                }, {
                    stops++
                    ui = ui.copy(holding = false, micOpen = false)
                }, Modifier.width(312.dp), light = light)
            }
        }
        val push = compose.onNodeWithTag("hold-to-talk")
        val tags = listOf("mic-mute", "speaker-mute", "hold-to-talk")
        val bounds = tags.map { compose.onNodeWithTag(it).getUnclippedBoundsInRoot() }
        push.performTouchInput { down(center) }
        repeat(12) { index ->
            compose.runOnIdle { light.value = PreviewButtonLight(index / 12f, .8f, index / 12f, .4f) }
            compose.runOnIdle { assertTrue(ui.holding); assertEquals(1, starts); assertEquals(0, stops) }
        }
        assertEquals(bounds, tags.map { compose.onNodeWithTag(it).getUnclippedBoundsInRoot() })
        push.performTouchInput { up() }
        compose.runOnIdle { assertFalse(ui.holding); assertFalse(ui.micOpen); assertEquals(1, stops) }
    }

    @Test fun disabledMotionAndOffStopTheSharedClockAndLevelModulation() {
        compose.mainClock.autoAdvance = false
        var allowed by mutableStateOf(true)
        var spirit by mutableStateOf(PreviewSpirit("soft", 35, "follow"))
        var ui by mutableStateOf(CallUi(connected = true, micMuted = false, micOpen = true, inputLevel = .3f))
        lateinit var scene: PreviewSpiritScene
        val halo = PreviewHalo(variant = "contained")
        compose.setContent { scene = rememberPreviewSpirit(ui, spirit, halo, "voice", allowed) }
        compose.mainClock.advanceTimeBy(1500)
        compose.runOnIdle { assertTrue(scene.light.value.amount > .3f); assertTrue(scene.light.value.phaseTurns > 0f); allowed = false }
        compose.mainClock.advanceTimeBy(32)
        val paused = compose.runOnIdle { scene.colors.value }
        compose.runOnIdle { assertEquals(PreviewButtonLight(), scene.light.value); ui = ui.copy(inputLevel = 0f) }
        compose.mainClock.advanceTimeBy(1500)
        compose.runOnIdle { assertEquals(paused, scene.colors.value); assertEquals(PreviewButtonLight(), scene.light.value) }
        compose.runOnIdle { allowed = true; spirit = PreviewSpirit() }
        compose.mainClock.advanceTimeBy(1500)
        compose.runOnIdle { assertEquals(halo.colors(), scene.colors.value); assertEquals(PreviewButtonLight(), scene.light.value) }
    }
}
