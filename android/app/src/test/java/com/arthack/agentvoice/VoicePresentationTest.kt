package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class VoicePresentationTest {
    private fun preparing(loaded: Boolean = true, owner: Boolean = true, ownerFailed: Boolean = false,
        loadFailed: Boolean = false, automatic: Boolean = false, selecting: Boolean = false,
        action: Boolean = false) = voicePreparation(loaded, owner, ownerFailed, loadFailed, automatic, selecting, action)

    @Test fun firstCompositionAndOwnerWaitArePreparationWithoutChangingCallTruth() {
        val ui = CallUi()
        for (preparation in listOf(preparing(loaded = false), preparing(owner = false), preparing(automatic = true), preparing(selecting = true))) {
            assertEquals(VoicePresentation.Preparing, voicePresentation(ui, preparation))
            assertFalse(ui.running); assertFalse(ui.connected); assertFalse(ui.canHold)
            assertEquals(PersonaState.Asleep, personaState(ui))
        }
        assertEquals(VoicePresentation.Disconnected, voicePresentation(ui, preparing()))
    }

    @Test fun errorsAndActionRequirementsCannotLookLikeAnActiveAttempt() {
        assertEquals(VoicePresentation.Failed, voicePresentation(CallUi(), preparing(owner = false, ownerFailed = true)))
        assertEquals(VoicePresentation.Failed, voicePresentation(CallUi(), preparing(loadFailed = true)))
        assertEquals(VoicePresentation.AwaitingAction, voicePresentation(CallUi(), preparing(action = true)))
        for (phase in listOf("Voice unavailable", "Voice stopped"))
            assertEquals(VoicePresentation.Failed, voicePresentation(CallUi(running = true, phase = phase)))
        assertEquals(VoicePresentation.Failed, voicePresentation(CallUi(message = "Network failed"), preparing(loaded = false)))
    }

    @Test fun explicitRetryCanPrepareOverAnOldFailureButRecreationCannotRetryIt() {
        val failed = CallUi(message = "Connection or audio failed.")
        assertEquals(VoicePresentation.Preparing, voicePresentation(failed, preparing(selecting = true)))
        assertEquals(VoicePresentation.Failed, voicePresentation(failed, preparing(owner = false)))
        val connecting = CallUi(running = true, phase = "Connecting voice")
        assertEquals(VoicePresentation.Connecting, voicePresentation(connecting))
        assertEquals(VoicePresentation.Disconnected, voicePresentation(connecting.copy(hasReachedLive = true)))
    }

    @Test fun savedAccessReloadFailureCannotReplaceARunningCallsState() {
        val opening = CallUi(running = true, phase = "Connecting voice")
        assertEquals(VoicePresentation.Connecting, voicePresentation(opening, VoicePreparation.Unavailable))
        assertEquals(VoicePresentation.Disconnected,
            voicePresentation(opening.copy(hasReachedLive = true), VoicePreparation.Unavailable))
        assertEquals(VoicePresentation.Failed,
            voicePresentation(opening.copy(phase = "Voice unavailable"), VoicePreparation.Unavailable))
    }

    @Test fun retainedLiveCallWinsOverLoadingAndControlAcknowledgement() {
        val live = CallUi(running = true, connected = true, controlsPending = true, micMuted = false)
        for (preparation in VoicePreparation.entries)
            assertEquals(VoicePresentation.Connected, voicePresentation(live, preparation))
        assertEquals(VoicePresentation.Disconnected, voicePresentation(CallUi(message = "Call ended.")))
        assertEquals(VoicePresentation.Failed, voicePresentation(CallUi(hasReachedLive = true, message = "Transport failed")))
    }
}
