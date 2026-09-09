package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.hypot

class PreviewCenterIndicatorModelTest {
    private val styles = listOf("words", "channels", "labeled", "contacts")
    private val scopes = listOf("both-muted", "any-muted", "always")

    @Test fun scopeUsesEveryEffectiveGateCombinationAndKeepsBothChannels() {
        for (mic in listOf(false, true)) for (speaker in listOf(false, true)) {
            val ui = CallUi(connected = true, micOpen = mic, speakerOpen = speaker,
                micMuted = !mic, speakerMuted = !speaker)
            for (style in styles) for (scope in scopes) {
                val expected = when (scope) {
                    "both-muted" -> !mic && !speaker
                    "any-muted" -> !mic || !speaker
                    else -> true
                }
                assertEquals("$style / $scope / $mic / $speaker", expected,
                    previewCenterIndicatorEligible(ui, style, scope, true))
                val model = previewCenterIndicatorModel(ui, style, scope, true)
                if (!expected) assertNull(model) else {
                    assertEquals(listOf(PreviewCenterChannelKind.Human, PreviewCenterChannelKind.Agent),
                        model!!.channels.map { it.kind })
                    assertEquals(listOf(mic, speaker), model.channels.map { it.open })
                }
            }
        }
    }

    @Test fun wordsAndChannelLabelsDescribeGatesWithoutNamingActivity() {
        val expected = mapOf(
            (false to false) to listOf("both", "muted"),
            (false to true) to listOf("human", "muted"),
            (true to false) to listOf("agent", "muted"),
            (true to true) to listOf("live"),
        )
        for ((gates, words) in expected) for (style in styles) {
            val ui = CallUi(connected = true, micOpen = gates.first, speakerOpen = gates.second)
            val model = previewCenterIndicatorModel(ui, style, "always", true)!!
            assertEquals(words, model.words)
            assertEquals(if (gates.first) "live" else "muted", model.channels[0].label)
            assertEquals(if (gates.second) "live" else "muted", model.channels[1].label)
            for (level in listOf(0f, .9f, Float.NaN, Float.POSITIVE_INFINITY)) {
                assertEquals("Activity must not invent a mode caption", model,
                    previewCenterIndicatorModel(ui.copy(inputLevel = level, outputLevel = level), style, "always", true))
            }
        }
    }

    @Test fun pushToTalkNeedsAnOpenGateAndReturnsToMutedOnRelease() {
        val ready = CallUi(connected = true, micMuted = true, speakerMuted = false,
            speakerOpen = true, canHold = true)
        for (style in styles) {
            fun model(ui: CallUi) = previewCenterIndicatorModel(ui, style, "always", true)!!
            assertEquals(listOf("human", "muted"), model(ready).words)
            val pressed = ready.copy(holding = true)
            assertEquals("An unconfirmed hold must not claim live capture", model(ready), model(pressed))
            val open = pressed.copy(micOpen = true)
            assertTrue(open.micMuted)
            assertEquals(listOf("live"), model(open).words)
            assertTrue(model(open).channels[0].open)
            assertFalse(previewCenterIndicatorEligible(open, style, "any-muted", true))
            val released = ready.copy(holding = false, micOpen = false)
            assertEquals(listOf("human", "muted"), model(released).words)
            assertTrue(previewCenterIndicatorEligible(released, style, "any-muted", true))
        }
    }

    @Test fun unmutedPreferencesCannotOverrideClosedTransportGates() {
        val closed = CallUi(connected = true, micMuted = false, speakerMuted = false,
            micOpen = false, speakerOpen = false, holding = true)
        for (style in styles) {
            val model = previewCenterIndicatorModel(closed, style, "both-muted", true)!!
            assertEquals(listOf("both", "muted"), model.words)
            assertTrue(model.channels.none { it.open })
        }
    }

    @Test fun lifecycleAndPendingControlsSuppressEveryTreatmentEvenWithStaleOpenGates() {
        val active = CallUi(connected = true, micOpen = true, speakerOpen = true)
        for (style in styles + "tide") for (scope in scopes) {
            for ((ui, foreground) in listOf(active.copy(connected = false) to true,
                active.copy(controlsPending = true) to true, active to false)) {
                assertFalse(previewCenterIndicatorEligible(ui, style, scope, foreground))
                assertNull(previewCenterIndicatorModel(ui, style, scope, foreground))
            }
        }
    }

    @Test fun tideKeepsBothMutedSemanticsAndUnknownSelectionsNeverDraw() {
        val ui = CallUi(connected = true)
        for (scope in scopes) {
            assertTrue(previewCenterIndicatorEligible(ui, "tide", scope, true))
            assertFalse(previewCenterIndicatorEligible(ui.copy(micOpen = true), "tide", scope, true))
            assertFalse(previewCenterIndicatorEligible(ui.copy(speakerOpen = true), "tide", scope, true))
            assertNull("Tide belongs to the original renderer", previewCenterIndicatorModel(ui, "tide", scope, true))
            for (style in listOf("off", "", "unknown")) {
                assertFalse(previewCenterIndicatorEligible(ui, style, scope, true))
                assertNull(previewCenterIndicatorModel(ui, style, scope, true))
            }
        }
        for (style in styles) for (scope in listOf("", "muted", "unknown")) {
            assertFalse(previewCenterIndicatorEligible(ui, style, scope, true))
        }
    }

    @Test fun everyRippleAtomFitsTheCompositeEnvelopeAndReducedMotionIsStill() {
        val tuning = PreviewMutedTuning(29, 0, 300, 100, 6, "ripple")
        val width = 116f
        val height = 74f
        val radius = 80f
        val fit = previewMutedPresenceFit(width, height, radius, tuning = tuning)!!
        assertTrue("Reduce motion rather than changing selected type size", fit.driftXPx < 3f)
        for (step in 0..120) {
            val frame = previewCenterIndicatorFrame(step / 120f, true, fit, tuning, 12)
            assertEquals("Both text rows and their icons need independent ripple atoms", 12, frame.glyphOffsets.size)
            for (wave in frame.glyphOffsets) for (xSign in listOf(-1, 1)) for (ySign in listOf(-1, 1)) {
                val x = frame.offsetX + xSign * width * frame.scale / 2.0
                val y = frame.offsetY + wave + ySign * height * frame.scale / 2.0
                assertTrue("Composite ink escaped the guarded aperture", hypot(x, y) + 8.0 <= radius + .0001)
            }
        }
        for (phase in listOf(0f, .5f, Float.NaN, Float.POSITIVE_INFINITY)) {
            val frame = previewCenterIndicatorFrame(phase, false, fit, tuning, 12)
            assertEquals(0f, frame.offsetX, 0f)
            assertEquals(0f, frame.offsetY, 0f)
            assertEquals(1f, frame.scale, 0f)
            assertTrue(frame.glyphOffsets.isEmpty())
        }
        assertNull("An impossible still block is omitted", previewMutedPresenceFit(width, height, 60f, tuning = tuning))
    }

    @Test fun minimumBrightnessRemovesEveryAtomWithoutChangingState() {
        val tuning = PreviewMutedTuning(brightnessPercent = -100, breathPercent = 100, motion = "ripple")
        val fit = previewMutedPresenceFit(40f, 20f, 80f, tuning = tuning)!!
        for (phase in listOf(0f, .25f, .5f, .75f)) for (moving in listOf(false, true)) {
            assertEquals(0f, previewCenterIndicatorFrame(phase, moving, fit, tuning, 12).alpha, 0f)
        }
    }
}
