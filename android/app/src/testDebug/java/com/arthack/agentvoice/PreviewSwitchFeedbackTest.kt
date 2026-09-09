package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class PreviewSwitchFeedbackTest {
    private class Output : PreviewSwitchOutput {
        val events = mutableListOf<Triple<String, PreviewSwitchCue, Float>>()
        var ready = true
        override fun play(family: String, cue: PreviewSwitchCue, gain: Float): Boolean {
            if (ready) events.add(Triple(family, cue, gain))
            return ready
        }
        override fun stop() = Unit
    }
    @Test fun explicitGesturesHaveOneRelatedPairAndIdenticalMuteCues() {
        val output = Output(); val feedback = PreviewSwitchFeedback(output)
        feedback.update(PreviewSounds("rocker-29", 70), true)
        assertTrue(output.events.isEmpty())
        feedback.toggle(); feedback.toggle(); feedback.down(); feedback.down(); feedback.release(); feedback.release()
        assertEquals(listOf(PreviewSwitchCue.Toggle, PreviewSwitchCue.Toggle, PreviewSwitchCue.Down, PreviewSwitchCue.Up), output.events.map { it.second })
        assertTrue(output.events.all { it.first == "rocker-29" && it.third == .7f })
    }
    @Test fun offVolumeAndBackgroundNeverPlayOrRetainARelease() {
        val output = Output(); val feedback = PreviewSwitchFeedback(output)
        for ((settings, active) in listOf(PreviewSounds() to true, PreviewSounds("rocker-13", 0) to true,
            PreviewSounds("rocker-13", 70) to false)) {
            feedback.update(settings, active); feedback.toggle(); feedback.down(); feedback.release()
        }
        assertTrue(output.events.isEmpty())
        feedback.update(PreviewSounds("rocker-13", 70), true)
        feedback.release(); assertTrue(output.events.isEmpty())
    }
    @Test fun cancellationOrSettingsChangesDiscardTheUpCue() {
        for (ending in listOf("cancel", "background", "family", "level", "off")) {
            val output = Output(); val feedback = PreviewSwitchFeedback(output)
            val settings = PreviewSounds("rocker-29", 70)
            feedback.update(settings, true); feedback.down()
            when (ending) {
                "cancel" -> feedback.cancel()
                "background" -> feedback.update(settings, false)
                "family" -> feedback.update(settings.copy(family = "rocker-13"), true)
                "level" -> feedback.update(settings.copy(volumePercent = 20), true)
                else -> feedback.update(PreviewSounds(), true)
            }
            feedback.update(settings, true); feedback.release()
            assertEquals(ending, listOf(PreviewSwitchCue.Down), output.events.map { it.second })
        }
    }
    @Test fun notReadyNeverQueuesOrProducesAnOrphanRelease() {
        val output = Output(); val feedback = PreviewSwitchFeedback(output)
        feedback.update(PreviewSounds("rocker-13", 70), true)
        output.ready = false; feedback.down(); feedback.toggle()
        output.ready = true; feedback.release()
        assertTrue(output.events.isEmpty())
        feedback.down(); feedback.update(PreviewSounds("rocker-13", 70), true); feedback.release()
        assertEquals(listOf(PreviewSwitchCue.Down, PreviewSwitchCue.Up), output.events.map { it.second })
    }
}
