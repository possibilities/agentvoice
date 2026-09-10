package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class AudioGateTest {
    private val muted = VoiceState(true, "live", ChannelState(true, true), ChannelState(false, false))
    private fun ready() = AudioGate().apply { connected = true; state(muted) }

    @Test fun captureAndPlaybackStartClosed() {
        val gate = AudioGate()
        assertFalse(gate.micOpen); assertFalse(gate.speakerOpen); assertFalse(gate.canHold)
    }
    @Test fun releaseClosesBeforeLateStateOrAcknowledgement() {
        val gate = ready()
        assertTrue(gate.hold())
        gate.release()
        gate.state(muted.copy(mic = ChannelState(true, false)))
        gate.acknowledgeHold()
        assertFalse(gate.micOpen)
        assertFalse(gate.holding)
    }
    @Test fun nextHoldDoesNotUseThePreviousServerOpenState() {
        val gate = ready()
        gate.hold(); gate.acknowledgeHold()
        gate.state(muted.copy(mic = ChannelState(true, false)))
        assertTrue(gate.micOpen)
        gate.release()
        gate.hold()
        assertFalse(gate.micOpen)
        gate.acknowledgeHold()
        assertTrue(gate.micOpen)
    }
    @Test fun holdRequiresBothServerStateAndAcknowledgement() {
        val gate = ready()
        gate.hold(); gate.acknowledgeHold()
        assertFalse(gate.micOpen)
        gate.state(muted.copy(mic = ChannelState(true, false)))
        assertTrue(gate.micOpen)
        gate.release()
        assertFalse(gate.micOpen)
    }
    @Test fun localMuteWinsOverAnOlderUnmutedState() {
        val gate = ready()
        val open = muted.copy(mic = ChannelState(false, false))
        gate.state(open)
        assertTrue(gate.micOpen)
        gate.intent("mic", true)
        gate.state(open)
        assertFalse(gate.micOpen)
        gate.state(muted)
        gate.acknowledgeMute("mic")
        assertFalse(gate.controlsPending)
        assertFalse(gate.micOpen)
    }
    @Test fun stateAndMuteReplyCanArriveInEitherOrder() {
        val gate = ready()
        gate.intent("speaker", true)
        gate.acknowledgeMute("speaker")
        assertFalse(gate.speakerOpen)
        assertTrue(gate.controlsPending)
        gate.state(muted.copy(speaker = ChannelState(true, true)))
        assertFalse(gate.controlsPending)
        assertFalse(gate.speakerOpen)
    }
    @Test fun unmuteNeverOpensBeforeServerConfirmation() {
        val gate = ready()
        gate.intent("mic", false)
        gate.acknowledgeMute("mic")
        assertFalse(gate.micOpen)
        gate.state(muted.copy(mic = ChannelState(false, false)))
        assertTrue(gate.micOpen)
    }
    @Test fun teardownAndFailedSessionFenceFurtherState() {
        val gate = ready()
        gate.hold(); gate.acknowledgeHold()
        gate.stop()
        gate.state(muted.copy(mic = ChannelState(true, false)))
        assertFalse(gate.micOpen); assertFalse(gate.speakerOpen)
        gate.connected = true
        gate.state(muted.copy(phase = "stopped", mic = ChannelState(false, false)))
        assertFalse(gate.micOpen); assertFalse(gate.speakerOpen)
    }
}
