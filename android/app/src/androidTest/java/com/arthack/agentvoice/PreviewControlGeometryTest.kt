package com.arthack.agentvoice

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewControlGeometryTest {
    @get:Rule val compose = createComposeRule()
    private val ready = CallUi(running = true, connected = true, phase = "Connected", micMuted = true,
        speakerMuted = false, speakerOpen = true, canHold = true)

    @Test fun defaultRockerDeckKeeps130_16_116Geometry() {
        compose.setContent { ControlFixture(ready) }
        compose.onNodeWithTag("preview-controls").assertHeightIsEqualTo(262.dp)
        compose.onNodeWithTag("mic-mute").assertHeightIsEqualTo(130.dp)
        compose.onNodeWithTag("speaker-mute").assertHeightIsEqualTo(130.dp)
        compose.onNodeWithTag("hold-to-talk").assertHeightIsEqualTo(116.dp)
            .assertContentDescriptionEquals("Push to talk")
        val deck = bounds("preview-controls")
        val talk = bounds("hold-to-talk")
        assertEquals(146f, (talk.top - deck.top).value, .5f)
        assertEquals(16f, (talk.top - bounds("mic-mute").bottom).value, .5f)
    }

    @Test fun extremeSplitsContainEveryTargetAtNormalAndLargerTextSizes() {
        var geometry by mutableStateOf(PreviewControlGeometry())
        var fontScale by mutableStateOf(1f)
        var ui by mutableStateOf(ready)
        compose.setContent { ControlFixture(ui, geometry, fontScale) }
        val states = listOf(ready,
            ready.copy(connected = false, phase = "Connecting voice", canHold = false),
            ready.copy(micMuted = false, micOpen = true, canHold = false),
            ready.copy(controlsPending = true, canHold = false))
        for (height in listOf(240, 480)) for (share in listOf(30.0, 60.0)) {
            val expectedTalk = (height * share / 100).toFloat()
            val expectedMute = height - 16f - expectedTalk
            var firstBounds: List<DpRect>? = null
            for (scale in listOf(1f, 1.5f)) for (state in states) {
                compose.runOnIdle {
                    geometry = PreviewControlGeometry(height, share)
                    fontScale = scale
                    ui = state
                }
                val context = "$height dp, $share%, font $scale, $state"
                val deck = bounds("preview-controls")
                val targets = listOf("mic-mute", "speaker-mute", "hold-to-talk").map { tag ->
                    compose.onNodeWithTag(tag).assertIsDisplayed()
                    bounds(tag).also { assertContained(deck, it, "$context: $tag") }
                }
                assertEquals(context, height.toFloat(), (deck.bottom - deck.top).value, .5f)
                assertEquals(context, expectedMute, (targets[0].bottom - targets[0].top).value, .5f)
                assertEquals(context, expectedTalk, (targets[2].bottom - targets[2].top).value, .5f)
                assertEquals(context, 16f, (targets[2].top - targets[0].bottom).value, .5f)
                assertEquals(context, 10f, (targets[1].left - targets[0].right).value, .5f)
                assertTrue(context, (targets[0].bottom - targets[0].top).value >= 79.5f)
                assertTrue(context, (targets[2].bottom - targets[2].top).value >= 71.5f)
                if (state.canHold) compose.onNodeWithTag("hold-to-talk").assertIsEnabled()
                else compose.onNodeWithTag("hold-to-talk").assertIsNotEnabled()
                if (firstBounds == null) firstBounds = targets else assertEquals(context, firstBounds, targets)
            }
        }
    }

    @Test fun changingEitherDimensionReleasesTheOwningPressThroughTheCurrentCallback() {
        var geometry by mutableStateOf(PreviewControlGeometry())
        var ui by mutableStateOf(ready)
        var visible by mutableStateOf(true)
        var presses = 0
        val releasedWith = mutableListOf<PreviewControlGeometry>()
        compose.setContent {
            val renderedGeometry = geometry
            if (visible) ControlFixture(ui, geometry, onHold = {
                presses++
                ui = ui.copy(holding = true, micOpen = true)
            }, onRelease = {
                releasedWith.add(renderedGeometry)
                ui = ui.copy(holding = false, micOpen = false)
            })
        }
        val sizes = listOf(PreviewControlGeometry(480), PreviewControlGeometry(480, 60.0),
            PreviewControlGeometry(240, 60.0))
        for ((index, next) in sizes.withIndex()) {
            compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
            compose.runOnIdle {
                assertTrue(ui.holding)
                geometry = next
            }
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(index + 1, releasedWith.size)
                assertEquals(next, releasedWith.last())
                assertFalse(ui.holding)
            }
            // A still-down pointer may move over the replacement surface, but cannot start a new press.
            compose.onNodeWithTag("hold-to-talk").performTouchInput { moveTo(center); up() }
            compose.runOnIdle { assertEquals(index + 1, presses); assertEquals(presses, releasedWith.size) }
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        compose.runOnIdle { visible = false }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(4, presses); assertEquals(4, releasedWith.size); assertFalse(ui.holding) }
    }

    @Test fun confirmedCaptureKeepsRockerFaceDark() {
        var ui by mutableStateOf(ready)
        compose.setContent {
            ControlFixture(ui, onHold = { ui = ui.copy(holding = true, micOpen = true) },
                onRelease = { ui = ui.copy(holding = false, micOpen = false) })
        }
        val talk = compose.onNodeWithTag("hold-to-talk")
        talk.performTouchInput { down(center) }
        val pixels = talk.captureToImage().toPixelMap()
        for (x in listOf(.7f, .8f, .9f)) for (y in listOf(.35f, .5f, .65f)) {
            val face = pixels[(pixels.width * x).toInt(), (pixels.height * y).toInt()]
            assertTrue("Rocker must not flood the thumb surface with bright lime", face.luminance() < .1f)
        }
        talk.performTouchInput { up() }
        compose.runOnIdle { assertFalse(ui.holding) }
    }

    private fun bounds(tag: String): DpRect = compose.onNodeWithTag(tag).getUnclippedBoundsInRoot()

    private fun assertContained(deck: DpRect, target: DpRect, context: String) {
        assertTrue("$context left edge escaped $deck: $target", target.left.value >= deck.left.value - .5f)
        assertTrue("$context right edge escaped $deck: $target", target.right.value <= deck.right.value + .5f)
        assertTrue("$context top edge escaped $deck: $target", target.top.value >= deck.top.value - .5f)
        assertTrue("$context bottom edge escaped $deck: $target", target.bottom.value <= deck.bottom.value + .5f)
    }
}

@Composable
private fun ControlFixture(
    ui: CallUi,
    geometry: PreviewControlGeometry = PreviewControlGeometry(),
    fontScale: Float = 1f,
    onHold: () -> Unit = {},
    onRelease: () -> Unit = {},
) {
    val density = LocalDensity.current
    CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
        VoiceTheme {
            Box(Modifier.fillMaxSize()) {
                PreviewControls(ui, {}, onHold, onRelease, Modifier.width(312.dp),
                    controlsHeightDp = geometry.controlsHeightDp, holdSharePercent = geometry.holdSharePercent)
            }
        }
    }
}
