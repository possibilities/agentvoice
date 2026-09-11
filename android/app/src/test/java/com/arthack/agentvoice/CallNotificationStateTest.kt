package com.arthack.agentvoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallNotificationStateTest {
    @Test fun onlyRunningCallsHaveNotificationState() {
        assertNull(callNotificationState(CallUi(), 25L))
        assertNull(callNotificationState(CallUi(message = "Connection ended"), 25L))

        val state = callNotificationState(CallUi(running = true, phase = "Connecting"), 25L)!!
        assertEquals("AgentVoice", state.identity)
        assertEquals("Connecting", state.phase)
        assertEquals(25L, state.startedAtElapsedRealtime)
    }

    @Test fun microphoneActionFollowsAuthoritativeUiState() {
        assertEquals("Unmute", callNotificationState(CallUi(running = true, micMuted = true), 0L)!!.micAction)
        assertEquals("Mute", callNotificationState(CallUi(running = true, micMuted = false), 0L)!!.micAction)
    }

    @Test fun chronometerWallTimeUsesElapsedClockAndClampsClockAnomalies() {
        assertEquals(900_000L, notificationWhenMillis(1_000_000L, 50_000L, -50_000L))
        assertEquals(1_000_000L, notificationWhenMillis(1_000_000L, 50_000L, 60_000L))
    }

    @Test fun staleNotificationCannotControlSuccessor() {
        assertTrue(ownsNotificationAction("successor", "successor"))
        assertFalse(ownsNotificationAction("successor", "old"))
        assertFalse(ownsNotificationAction(null, "old"))
        assertFalse(ownsNotificationAction("successor", null))
    }
}
