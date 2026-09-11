package com.arthack.agentvoice

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceConnectionNoticeStateTest {
    @Test fun connectedAndStartupStatesDoNotInventAClosingPhase() {
        assertEquals("connected", voiceConnectionNoticeState(CallUi(connected = true, running = true)))
        assertEquals("connecting", voiceConnectionNoticeState(CallUi(running = true, phase = "Connecting voice")))
        assertEquals("failed", voiceConnectionNoticeState(CallUi(running = true, phase = "Voice unavailable")))
        assertEquals("failed", voiceConnectionNoticeState(CallUi(running = true, phase = "Voice stopped")))
    }
    @Test fun intentionalEndsRemainDisconnectedWhileActualErrorsKeepTheirFailure() {
        assertEquals("disconnected", voiceConnectionNoticeState(CallUi()))
        assertEquals("disconnected", voiceConnectionNoticeState(CallUi(message = "Call ended.")))
        assertEquals("disconnected", voiceConnectionNoticeState(CallUi(message = "Call ended when the app left the foreground.")))
        assertEquals("failed", voiceConnectionNoticeState(CallUi(message = "Network changed. Check Tailscale, then start again.")))
    }
}
