package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class CallNavigationTest {
    @Test fun firstUseOpensScannerAndPairingEntersPersona() {
        val first = CallNavigation().loaded(false)
        assertEquals(CallRoute.Scanner, first.route)
        assertEquals(CallRoute.Connection, first.back().route)
        assertEquals(CallRoute.Scanner, first.back().scan().route)
        assertEquals(CallRoute.Persona, first.enterCall().route)
    }

    @Test fun navigationAndForegroundCannotClaimAnotherAutomaticAttempt() {
        val initial = CallNavigation().loaded(true)
        assertTrue(initial.shouldAutoConnect(true, true, true, true))
        assertFalse(initial.shouldAutoConnect(true, true, true, false))
        val call = initial.enterCall()
        assertFalse(call.back().shouldAutoConnect(true, true, true, true))
        assertEquals(CallRoute.Persona, call.back().enterCall().route)
        assertFalse(call.disconnected().shouldAutoConnect(true, true, true, true))
    }

    @Test fun hintRegionNeverOverlapsDeckInEitherHandOrAxis() {
        for (portrait in listOf(true, false)) for (side in listOf("left", "right")) {
            val width = if (portrait) 360f else 760f
            val height = if (portrait) 760f else 360f
            val geometry = previewOrientationGeometry(width, height, width, portrait, 340f, 0f, side)
            val hint = personaHintBounds(geometry, width, height)
            assertTrue(hint.width > 0 && hint.height > 0)
            assertTrue(hint.x >= 0 && hint.x + hint.width <= width)
            assertTrue(hint.y >= 0 && hint.y + hint.height <= height)
            if (portrait) assertTrue(hint.y + hint.height <= geometry.deckY)
            else if (side == "left") assertTrue(hint.x + hint.width <= geometry.deckX)
            else assertTrue(hint.x >= geometry.deckX + geometry.deckWidth)
        }
    }
}
