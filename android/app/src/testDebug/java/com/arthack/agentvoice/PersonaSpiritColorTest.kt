package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PersonaSpiritColorTest {
    private val colors = CompactHaloColors(0xFFBBAAFF.toInt(), 0xFFD4FF72.toInt(), 0xFFF0F2E9.toInt())
    private val open = CallUi(connected = true, micOpen = true, speakerOpen = true, outputLevel = .1f)

    @Test fun offAndDisconnectKeepTheExactUserPalette() {
        assertSame(colors, personaSpiritColors(colors, open, .5f, 1f, amount = 0f))
        assertSame(colors, personaSpiritColors(colors, open.copy(connected = false), .5f, 1f))
        assertSame(colors, personaSpiritColors(colors, open, .5f, 1f, amount = Float.NaN))
    }

    @Test fun effectiveMicrophoneGateHonorsPushToTalkAndFencesStaleHoldEnergy() {
        val held = CallUi(connected = true, micMuted = true, holding = true, micOpen = true, speakerOpen = false)
        val quiet = personaSpiritColors(colors, held, 0f)
        val energetic = personaSpiritColors(colors, held, 0f, energy = 1f)
        assertNotEquals(quiet.listening, energetic.listening)
        assertEquals(quiet.speaking, energetic.speaking)
        assertEquals(quiet.idle, energetic.idle)
        assertEquals(energetic, personaSpiritColors(colors, held.copy(micMuted = false), 0f, 1f))

        val closed = held.copy(micOpen = false)
        assertEquals(personaSpiritColors(colors, closed, 0f), personaSpiritColors(colors, closed, .5f, 1f))
    }

    @Test fun energyAffectsOnlyTheCurrentlyAudibleState() {
        val quiet = personaSpiritColors(colors, open, 0f)
        val energetic = personaSpiritColors(colors, open, 0f, 1f)
        assertNotEquals(quiet.speaking, energetic.speaking)
        assertEquals(quiet.listening, energetic.listening)
        assertEquals(quiet.idle, energetic.idle)

        val closedSpeaker = open.copy(speakerOpen = false)
        val closedQuiet = personaSpiritColors(colors, closedSpeaker, 0f)
        val closedEnergetic = personaSpiritColors(colors, closedSpeaker, 0f, 1f)
        assertEquals(closedQuiet.speaking, closedEnergetic.speaking)
        assertNotEquals(closedQuiet.listening, closedEnergetic.listening)
    }

    @Test fun pendingAndReducedMotionSuppressThePhaseAndEnergy() {
        val steady = personaSpiritColors(colors, open, 0f)
        assertEquals(steady, personaSpiritColors(colors, open, .5f, 1f, motionAllowed = false))
        assertEquals(steady, personaSpiritColors(colors, open.copy(controlsPending = true), .5f, 1f))
        val closed = open.copy(micOpen = false, speakerOpen = false)
        assertEquals(personaSpiritColors(colors, closed, 0f), personaSpiritColors(colors, closed, .5f, 1f))
    }

    @Test fun idleReflectsOnlyTheSoleOpenColorFamily() {
        val custom = CompactHaloColors(0xFF2030B0.toInt(), 0xFFA02010.toInt(), 0xFF707070.toInt())
        val microphone = open.copy(speakerOpen = false)
        val speaker = open.copy(micOpen = false)
        val redIdle = personaSpiritColors(custom, microphone, 0f).idle
        val blueIdle = personaSpiritColors(custom, speaker, 0f).idle
        assertTrue(component(redIdle, 16) > component(redIdle, 0))
        assertTrue(component(blueIdle, 0) > component(blueIdle, 16))
        assertEquals(redIdle, personaSpiritColors(custom.copy(speaking = 0xFF00FF00.toInt()), microphone, 0f).idle)
        assertEquals(blueIdle, personaSpiritColors(custom.copy(listening = 0xFFFFFF00.toInt()), speaker, 0f).idle)
        assertEquals(custom.idle, personaSpiritColors(custom, open, 0f).idle)
        val closedIdle = personaSpiritColors(custom, open.copy(micOpen = false, speakerOpen = false), 0f).idle
        for (shift in listOf(0, 8, 16)) assertTrue(component(closedIdle, shift) < component(custom.idle, shift))
    }

    @Test fun customColorsRemainOpaqueWithSmallTonalExcursions() {
        val custom = CompactHaloColors(0xFF0000FF.toInt(), 0xFFFF0000.toInt(), 0xFF101010.toInt())
        for (phase in listOf(0f, .25f, .5f, .75f, 1f)) {
            for (ui in listOf(open, open.copy(speakerOpen = false), open.copy(micOpen = false, speakerOpen = false))) {
                val result = personaSpiritColors(custom, ui, phase, 1f)
                for (color in listOf(result.speaking, result.listening, result.idle)) assertEquals(255, color ushr 24)
                assertTrue(component(result.speaking, 0) >= 234)
                assertTrue(component(result.listening, 16) >= 234)
                for (shift in listOf(8, 16)) assertTrue(component(result.speaking, shift) <= 11)
                for (shift in listOf(0, 8)) assertTrue(component(result.listening, shift) <= 11)
            }
        }
    }

    @Test fun cycleAndBlendEndpointsAreStable() {
        assertEquals(personaSpiritColors(colors, open, 0f), personaSpiritColors(colors, open, 1f))
        val target = personaSpiritColors(colors, open.copy(speakerOpen = false), .5f, 1f)
        assertSame(colors, blendPersonaSpiritColors(colors, target, 0f))
        assertSame(target, blendPersonaSpiritColors(colors, target, 1f))
        assertSame(colors, blendPersonaSpiritColors(colors, target, Float.NaN))
        assertSame(target, blendPersonaSpiritColors(colors, target, 2f))
        val middle = blendPersonaSpiritColors(colors, target, .5f)
        for ((start, end, mid) in listOf(
            Triple(colors.speaking, target.speaking, middle.speaking),
            Triple(colors.listening, target.listening, middle.listening),
            Triple(colors.idle, target.idle, middle.idle),
        )) {
            assertEquals(255, mid ushr 24)
            for (shift in listOf(0, 8, 16)) {
                val range = listOf(component(start, shift), component(end, shift))
                assertTrue(component(mid, shift) in range.min()..range.max())
            }
        }
    }

    private fun component(color: Int, shift: Int) = (color ushr shift) and 255
}
