package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewSpiritMotionTest {
    private val listening = CallUi(connected = true, micMuted = false, micOpen = true, inputLevel = .3f)
    private val base = CompactHaloColors()
    private val spirit = PreviewSpirit("soft", 35, "follow")

    @Test fun ambientHasIndependentStrengthButSharesPhaseAndFencesVisibility() {
        val motion = PreviewSpiritMotion()
        fun step(percent: Int = 100, foreground: Boolean = true, dt: Float = 1f / 30) =
            motion.step(listening, PreviewSpirit(), base, false, "steady", dt, true, percent, foreground)
        val first = step()
        assertTrue(first.ambient.amount in .03f.. .05f)
        repeat(90) { step() }
        val lit = step()
        assertTrue(lit.ambient.amount > .95f)
        assertTrue(lit.ambient.phaseTurns > 0f)
        assertEquals(PreviewButtonLight(), lit.light)
        assertEquals(base, lit.colors)
        val shared = motion.step(listening, spirit, base, false, "steady", .03f, true, 100)
        assertEquals(shared.light.phaseTurns, shared.ambient.phaseTurns)
        assertEquals(PreviewAmbientFrame(), step(foreground = false).ambient)
        val returned = step(dt = 0f)
        assertEquals(PreviewButtonLight(), returned.light)
        assertEquals(PreviewAmbientFrame(), returned.ambient)
        step()
        assertEquals(PreviewAmbientFrame(), step(percent = 0).ambient)
        for (ui in listOf(listening.copy(connected = false), listening.copy(controlsPending = true))) {
            assertEquals(PreviewAmbientFrame(), motion.step(ui, spirit, base, true, "voice", .03f, true, 100).ambient)
        }
    }

    @Test fun reducedMotionKeepsAStillGlowWithoutEnergyOrPhase() {
        val motion = PreviewSpiritMotion()
        val first = motion.step(listening, PreviewSpirit(), base, false, "voice", .1f, false, 45)
        assertEquals(PreviewAmbientFrame(0f, .45f), first.ambient)
        repeat(60) {
            val next = motion.step(listening.copy(inputLevel = it / 60f), PreviewSpirit(), base, false, "voice", 1f, false, 45)
            assertEquals(first, next)
        }
        assertEquals(PreviewAmbientFrame(), motion.step(listening, spirit, base, true, "voice", .1f, false, 45, false).ambient)
    }

    @Test fun energyArrivesLazilyButClosedGatesClearImmediately() {
        val first = spiritEnvelope(0f, 1f, 1f / 30, true)
        assertTrue(first in .1f.. .2f)
        val released = spiritEnvelope(first, 0f, 1f / 30, true)
        assertTrue(released > first * .9f)
        assertEquals(0f, spiritEnvelope(first, 1f, 1f / 30, false))
        assertEquals(0f, spiritEnvelope(Float.NaN, Float.POSITIVE_INFINITY, 1f, true))
    }

    @Test fun mediaTruthWinsOverTrailingActivityAndMutePreference() {
        val motion = PreviewSpiritMotion()
        repeat(60) { motion.step(listening, spirit, base, true, "steady", 1f / 30, true) }
        val held = listening.copy(micMuted = true, holding = true)
        assertTrue(motion.step(held, spirit, base, true, "steady", .03f, true).light.captureEnergy > .8f)
        val closed = motion.step(held.copy(micOpen = false), spirit, base, true, "steady", .03f, true)
        assertEquals(0f, closed.light.captureEnergy)
        for (ui in listOf(listening.copy(connected = false), listening.copy(controlsPending = true))) {
            assertEquals(PreviewButtonLight(), motion.step(ui, spirit, base, true, "voice", .03f, true).light)
        }
    }

    @Test fun reducedMotionFreezesDriftAndEnergyButPreservesStaticGateColor() {
        val motion = PreviewSpiritMotion()
        val first = motion.step(listening, spirit, base, true, "voice", .1f, false)
        repeat(60) {
            assertEquals(first, motion.step(listening.copy(inputLevel = it / 60f), spirit, base, true, "voice", .1f, false))
        }
        assertEquals(PreviewButtonLight(), first.light)
        assertNotEquals(base, first.colors)
    }

    @Test fun offIsExactAndOriginalKeepsItsPalette() {
        val motion = PreviewSpiritMotion()
        repeat(60) { motion.step(listening, spirit, base, true, "voice", .03f, true) }
        val off = motion.step(listening, PreviewSpirit(), base, true, "voice", .03f, false)
        assertEquals(PreviewSpiritFrame(PreviewButtonLight(), base), off)
        repeat(60) { assertEquals(base, motion.step(listening, spirit, base, false, "voice", .03f, true).colors) }
    }

    @Test fun syntheticVoiceHasPausesAndOnlyDrivesTheSelectedOpenChannel() {
        val levels = (0..240).map { syntheticSpiritEnergy(it / 50f) }
        assertTrue(levels.max() > .7f)
        assertTrue(levels.count { it == 0f } > 40)
        assertTrue(levels.all { it in 0f..1f })
        val motion = PreviewSpiritMotion()
        repeat(30) { motion.step(listening, spirit, base, true, "voice", .03f, true) }
        val frame = motion.step(listening, spirit, base, true, "voice", .03f, true)
        assertTrue(frame.light.captureEnergy > 0f)
        assertEquals(0f, frame.light.playbackEnergy)
    }
}
