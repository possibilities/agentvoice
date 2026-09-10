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
}
