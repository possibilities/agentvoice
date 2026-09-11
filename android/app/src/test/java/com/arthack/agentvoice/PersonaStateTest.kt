package com.arthack.agentvoice

import org.junit.Assert.assertEquals
import org.junit.Test

class PersonaStateTest {
    @Test fun closedAudioGatesNeverClaimListeningOrSpeaking() {
        val silent = CallUi(connected = true, inputLevel = .8f, outputLevel = .8f)
        assertEquals(PersonaState.Idle, personaState(silent))
        assertEquals(PersonaState.Listening, personaState(silent.copy(micOpen = true)))
        assertEquals(PersonaState.Speaking, personaState(silent.copy(micOpen = true, speakerOpen = true)))
        assertEquals(PersonaState.Asleep, personaState(silent.copy(connected = false, micOpen = true, speakerOpen = true)))
    }
    @Test fun openPlaybackWithoutAudioDoesNotClaimSpeech() {
        assertEquals(PersonaState.Idle, personaState(CallUi(connected = true, speakerOpen = true)))
        assertEquals(PersonaState.Asleep, personaState(CallUi(running = true, phase = "Connecting voice")))
    }
    @Test fun thinkingRequiresKnownWorkAndYieldsToAudibleVoiceOrHumanActivity() {
        val working = CallUi(connected = true, codingActivity = CodingActivity.Working)
        assertEquals(PersonaState.Thinking, personaState(working))
        assertEquals(PersonaState.Thinking, personaState(working.copy(micOpen = true)))
        assertEquals(PersonaState.Thinking, personaState(working.copy(speakerOpen = true)))
        assertEquals(PersonaState.Listening, personaState(working.copy(micOpen = true, holding = true)))
        assertEquals(PersonaState.Listening, personaState(working.copy(micOpen = true, inputLevel = .08f)))
        assertEquals(PersonaState.Thinking, personaState(working.copy(inputLevel = .08f)))
        assertEquals(PersonaState.Speaking, personaState(working.copy(speakerOpen = true, outputLevel = .08f, micOpen = true, holding = true)))
        assertEquals(PersonaState.Asleep, personaState(working.copy(connected = false)))
        for (activity in listOf(CodingActivity.Idle, CodingActivity.Blocked, CodingActivity.Unknown))
            assertEquals(PersonaState.Idle, personaState(working.copy(codingActivity = activity)))
    }
}
