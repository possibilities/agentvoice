package com.arthack.agentvoice

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.PixelMap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import kotlin.math.hypot
import kotlin.math.roundToInt

class PreviewCenterIndicatorTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun wordsAndLabeledKeepLargeTypeInsideTheCurrentApertureThenOmitImpossibleFits() {
        compose.mainClock.autoAdvance = false
        var style by mutableStateOf("words")
        var ui by mutableStateOf(CallUi(connected = true))
        var tuning by mutableStateOf(PreviewMutedTuning(textSizeSp = 29, driftPercent = 0))
        var radius by mutableStateOf(80.dp)
        val phase = mutableFloatStateOf(0f)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1f)) {
                Box(Modifier.size(260.dp).background(VoiceInk.ground).testTag("center-test-stage")) {
                    PreviewCenterIndicator(ui, style, "always", true, false, phase, 260.dp, 0.dp, radius, tuning)
                }
            }
        }
        for (treatment in listOf("words", "labeled")) {
            compose.runOnIdle { style = treatment; ui = CallUi(connected = true); tuning = tuning.copy(textSizeSp = 29) }
            compose.mainClock.advanceTimeBy(32)
            indicator().assertExists()
            val large = pixels()
            val unit = large.width / 260f
            val lit = inkCoordinates(large)
            assertTrue("The selected 29 sp type must actually draw", lit.size > 100)
            assertTrue("The renderer must not silently shrink large words",
                (lit.maxOf { it.first } - lit.minOf { it.first }) / unit > 74f)
            assertTrue("Both rows must draw", (lit.maxOf { it.second } - lit.minOf { it.second }) / unit > 40f)
            assertInkInside(large, 80f, 0f)
            val states = mutableSetOf<List<Int>>()
            for (gates in listOf(false to false, false to true, true to false, true to true)) {
                compose.runOnIdle { ui = ui.copy(micOpen = gates.first, speakerOpen = gates.second) }
                compose.mainClock.advanceTimeBy(32)
                indicator().assertExists()
                states += fingerprint(pixels())
            }
            assertEquals("Every effective gate combination must render its own text", 4, states.size)
            compose.runOnIdle { ui = CallUi(connected = true); tuning = tuning.copy(textSizeSp = 14) }
            compose.mainClock.advanceTimeBy(32)
            assertTrue("Actual type area should track the selected size", lit.size > inkCoordinates(pixels()).size * 2)
            compose.runOnIdle { tuning = tuning.copy(textSizeSp = 29); radius = 24.dp }
            compose.mainClock.advanceTimeBy(32)
            indicator().assertDoesNotExist()
            assertTrue(inkCoordinates(pixels()).isEmpty())
            compose.runOnIdle { radius = 80.dp }
        }
    }

    @Test fun largeWordsFitDownWithoutDisappearingAtTheOperatorsTightAperture() {
        compose.mainClock.autoAdvance = false
        var radius by mutableStateOf(100.dp)
        var fontScale by mutableFloatStateOf(1f)
        var humanOpen by mutableStateOf(false)
        val phase = mutableFloatStateOf(0f)
        val tuning = PreviewMutedTuning(32, -19, 196, 65, 13, "float")
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                Box(Modifier.size(260.dp).background(VoiceInk.ground).testTag("center-test-stage")) {
                    PreviewCenterIndicator(CallUi(connected = true, micOpen = humanOpen, speakerOpen = true),
                        "words", "always", true, true, phase, 260.dp, 0.dp, radius, tuning)
                }
            }
        }
        for (systemScale in listOf(1f, 1.5f)) {
            compose.runOnIdle { fontScale = systemScale; radius = 100.dp; humanOpen = false }
            compose.mainClock.advanceTimeBy(32)
            val preferred = inkCoordinates(pixels())
            assertTrue(preferred.size > 100)
            compose.runOnIdle { radius = 50.dp }
            compose.mainClock.advanceTimeBy(32)
            indicator().assertExists()
            val fitted = inkCoordinates(pixels())
            assertTrue("Human muted must remain visible when selected 32 sp cannot fit", fitted.size > 100)
            assertTrue("Type should fit down instead of crossing the ring", fitted.size < preferred.size)
            for (next in listOf(0f, .25f, .5f, .75f)) {
                compose.runOnIdle { phase.floatValue = next }
                compose.mainClock.advanceTimeBy(16)
                assertInkInside(pixels(), 50f, 0f)
            }
            compose.runOnIdle { humanOpen = true }
            compose.mainClock.advanceTimeBy(16)
            indicator().assertExists()
            assertTrue(inkCoordinates(pixels()).size > 40)
            assertInkInside(pixels(), 50f, 0f)
            assertEquals("Fitting must not rewrite the requested size", 32, tuning.textSizeSp)
        }
    }

    @Test fun channelAndContactInkFollowsAcknowledgedGatesAndClearsImmediately() {
        compose.mainClock.autoAdvance = false
        var style by mutableStateOf("channels")
        var ui by mutableStateOf(CallUi(connected = true, micOpen = true, speakerOpen = true))
        var foreground by mutableStateOf(true)
        val phase = mutableFloatStateOf(0f)
        compose.setContent {
            Box(Modifier.size(260.dp).background(VoiceInk.ground).testTag("center-test-stage")) {
                PreviewCenterIndicator(ui, style, "always", foreground, false, phase, 260.dp, 0.dp, 110.dp,
                    PreviewMutedTuning(textSizeSp = 29))
            }
        }
        for (treatment in listOf("channels", "labeled", "contacts")) {
            compose.runOnIdle { style = treatment; ui = CallUi(connected = true, micOpen = true, speakerOpen = true) }
            compose.mainClock.advanceTimeBy(16)
            val open = pixels()
            assertTrue("Human live ink must draw", coloredPixels(open, human = true) > 2)
            assertTrue("Agent live ink must draw", coloredPixels(open, human = false) > 2)
            compose.runOnIdle { ui = ui.copy(micOpen = false, speakerOpen = false, micMuted = false, speakerMuted = false) }
            compose.mainClock.advanceTimeByFrame()
            val closed = pixels()
            assertNotEquals(fingerprint(open), fingerprint(closed))
            assertEquals("Closing gates cannot retain live color during a fade", 0, coloredPixels(closed, true))
            assertEquals(0, coloredPixels(closed, false))
            assertTrue(inkCoordinates(closed).isNotEmpty())
        }
        for (fence in listOf("pending", "disconnected", "background")) {
            compose.runOnIdle {
                foreground = fence != "background"
                ui = CallUi(connected = fence != "disconnected", controlsPending = fence == "pending",
                    micOpen = true, speakerOpen = true)
            }
            compose.mainClock.advanceTimeByFrame()
            indicator().assertDoesNotExist()
            assertTrue("Unavailable transport cannot leave stale center ink", inkCoordinates(pixels()).isEmpty())
        }
    }

    @Test fun contactsShowAJoinedBridgeOrAnOpenGapInsteadOfOnlyChangingColor() {
        compose.mainClock.autoAdvance = false
        var open by mutableStateOf(true)
        val phase = mutableFloatStateOf(0f)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1f)) {
                Box(Modifier.size(260.dp).background(VoiceInk.ground).testTag("center-test-stage")) {
                    PreviewCenterIndicator(CallUi(connected = true, micOpen = open, speakerOpen = open), "contacts",
                        "always", true, false, phase, 260.dp, 0.dp, 80.dp,
                        PreviewMutedTuning(textSizeSp = 29, brightnessPercent = 100))
                }
            }
        }
        compose.mainClock.advanceTimeBy(32)
        fun rightGap(map: PixelMap): Float {
            val unit = map.width / 260f
            val x = (map.width / 2f - .4f * 29f * unit).roundToInt()
            val y = (map.height / 2f + .105f * 29f * unit).roundToInt()
            return maxOf(map[x, y].red, map[x, y].green, map[x, y].blue)
        }
        assertTrue("A live contact must join both terminals", rightGap(pixels()) > .3f)
        compose.runOnIdle { open = false }
        compose.mainClock.advanceTimeByFrame()
        assertTrue("The muted contact must visibly break before the right terminal", rightGap(pixels()) < .08f)
        assertTrue("Lifted arms and both terminals remain present", inkCoordinates(pixels()).size > 20)
    }

    @Test fun sharedRippleStopsForReducedMotionAndNegativeBrightnessDimsEveryTreatment() {
        compose.mainClock.autoAdvance = false
        var style by mutableStateOf("words")
        var allowed by mutableStateOf(true)
        var tuning by mutableStateOf(PreviewMutedTuning(29, 0, 300, 100, 6, "ripple"))
        val phase = mutableFloatStateOf(0f)
        compose.setContent {
            Box(Modifier.size(260.dp).background(VoiceInk.ground).testTag("center-test-stage")) {
                PreviewCenterIndicator(CallUi(connected = true), style, "always", true, allowed, phase,
                    260.dp, (-12).dp, 80.dp, tuning)
            }
        }
        for (treatment in listOf("words", "channels", "labeled", "contacts")) {
            compose.runOnIdle { style = treatment; allowed = true; phase.floatValue = 0f; tuning = tuning.copy(brightnessPercent = 0) }
            compose.mainClock.advanceTimeBy(32)
            indicator().assertExists()
            val first = fingerprint(pixels())
            for (next in listOf(.25f, .5f, .75f)) {
                compose.runOnIdle { phase.floatValue = next }
                compose.mainClock.advanceTimeBy(16)
                assertInkInside(pixels(), 80f, -12f)
            }
            assertNotEquals("The shared phase must move the selected treatment", first, fingerprint(pixels()))
            compose.runOnIdle { allowed = false }
            compose.mainClock.advanceTimeBy(16)
            val still = fingerprint(pixels())
            compose.runOnIdle { phase.floatValue = .1f }
            compose.mainClock.advanceTimeBy(500)
            assertEquals("Reduced motion must remain still for $treatment", still, fingerprint(pixels()))
            val bright = maximumInk(pixels())
            compose.runOnIdle { tuning = tuning.copy(brightnessPercent = -75) }
            compose.mainClock.advanceTimeBy(16)
            assertTrue("Negative brightness must dim icons and text", maximumInk(pixels()) < bright * .5f)
            compose.runOnIdle { tuning = tuning.copy(brightnessPercent = -100) }
            compose.mainClock.advanceTimeBy(16)
            assertTrue("Minimum brightness must clear every treatment", maximumInk(pixels()) < .04f)
        }
    }

    @Test fun centerOverlayPassesAnOngoingPointerToTheControlUnderIt() {
        compose.mainClock.autoAdvance = false
        var style by mutableStateOf("labeled")
        var ui by mutableStateOf(CallUi(connected = true))
        var presses = 0
        var releases = 0
        val phase = mutableFloatStateOf(0f)
        compose.setContent {
            Box(Modifier.size(260.dp).background(VoiceInk.ground).testTag("center-test-stage")) {
                Box(Modifier.matchParentSize().pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        down.consume()
                        presses++
                        waitForUpOrCancellation()?.let { it.consume(); releases++ }
                    }
                })
                PreviewCenterIndicator(ui, style, "always", true, false, phase, 260.dp, 0.dp, 100.dp,
                    PreviewMutedTuning(textSizeSp = 29))
            }
        }
        compose.mainClock.advanceTimeBy(32)
        indicator().assertHasNoClickAction()
        val stage = compose.onNodeWithTag("center-test-stage")
        stage.performTouchInput { down(center) }
        compose.runOnIdle { assertEquals(1, presses); assertEquals(0, releases); style = "contacts"; ui = ui.copy(micOpen = true) }
        compose.mainClock.advanceTimeBy(16)
        stage.performTouchInput { up() }
        compose.runOnIdle { assertEquals(1, presses); assertEquals(1, releases) }
    }

    private fun indicator() = compose.onNodeWithTag("preview-center-indicator", useUnmergedTree = true)
    private fun pixels() = compose.onNodeWithTag("center-test-stage").captureToImage().toPixelMap()
    private fun fingerprint(map: PixelMap) = List(map.width * map.height) { map[it % map.width, it / map.width].hashCode() }

    private fun inkCoordinates(map: PixelMap): List<Pair<Int, Int>> = buildList {
        for (y in 0 until map.height) for (x in 0 until map.width) {
            val color = map[x, y]
            if (maxOf(color.red, color.green, color.blue) > .12f) add(x to y)
        }
    }

    private fun assertInkInside(map: PixelMap, radiusDp: Float, offsetDp: Float) {
        val unit = map.width / 260f
        for ((x, y) in inkCoordinates(map)) {
            val distance = hypot((x + .5f - map.width / 2f).toDouble(),
                (y + .5f - map.height / 2f - offsetDp * unit).toDouble())
            assertTrue("Ink crossed the protected aperture", distance <= (radiusDp - 8f) * unit + 1f)
        }
    }

    private fun coloredPixels(map: PixelMap, human: Boolean): Int {
        var count = 0
        for (y in 0 until map.height) for (x in 0 until map.width) {
            val color = map[x, y]
            if (if (human) color.green - color.blue > .075f else color.blue - color.green > .075f) count++
        }
        return count
    }

    private fun maximumInk(map: PixelMap): Float {
        var maximum = 0f
        for (y in 0 until map.height) for (x in 0 until map.width) {
            val color = map[x, y]
            maximum = maxOf(maximum, color.red, color.green, color.blue)
        }
        return maximum
    }
}
