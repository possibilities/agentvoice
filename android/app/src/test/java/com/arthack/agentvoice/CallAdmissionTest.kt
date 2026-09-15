package com.arthack.agentvoice

import org.junit.Assert.*
import org.junit.Test

class CallAdmissionTest {
    private val token = "a".repeat(43)

    @Test fun onlyExplicitConfirmationReusesTheSameClientAndToken() {
        val admission = CallAdmission("phone")
        assertEquals("confirm", admission.initialRequest().string("takeover"))
        val challenge = admission.response(token)!!
        assertEquals("TakeoverChallenge(redacted)", challenge.toString())
        val confirm = admission.confirm(challenge)!!
        assertEquals("phone", confirm.string("clientId"))
        assertEquals(token, confirm.obj("takeover").string("token"))
        assertNull(admission.confirm(challenge))
        assertNull(admission.response(null))
        assertNull(admission.confirm(challenge))
    }

    @Test fun expiredChallengeNeedsAnotherExplicitConfirmation() {
        val admission = CallAdmission()
        admission.initialRequest()
        val first = admission.response(token)!!
        admission.confirm(first)
        val newer = admission.response("b".repeat(43))!!
        assertNull(admission.confirm(first))
        assertEquals(newer.token, admission.confirm(newer)!!.obj("takeover").string("token"))
    }

    @Test fun oldDialogCannotConfirmOnASuccessorTransport() {
        val first = CallAdmission()
        first.initialRequest()
        val old = first.response(token)!!
        val next = CallAdmission()
        next.initialRequest()
        val current = next.response(token)!!
        assertNull(next.confirm(old))
        assertNotNull(next.confirm(current))
    }

    @Test fun waitingForTheHumanHasNoPendingCallTimeout() {
        var now = 0L
        val ledger = WireLedger { now }
        val request = ledger.request("call", CallAdmission().initialRequest())
        ledger.response(request.id)
        repeat(12) {
            now += 20_000
            ledger.pong("a".repeat(32))
            ledger.checkLiveness()
        }
    }

    @Test fun structuredCleanupFailureKeepsItsMeaningWithoutDisplayingServerText() {
        val response = parseFrame("""{"v":3,"type":"response","id":"1","ok":false,"error":{"message":"internal details","code":"media_detach_failed"}}""") as ServerFrame.Response
        assertEquals("media_detach_failed", response.errorCode)
        val message = callAdmissionFailure(response.errorCode)
        assertTrue(message.contains("conversation and agent work are kept"))
        assertFalse(message.contains("internal details"))
    }

    @Test fun challengesAreStrictAndResponseIdsRemainCorrelated() {
        val ledger = WireLedger { 0L }
        val request = ledger.request("call", CallAdmission().initialRequest())
        val frame = parseFrame("""{"v":3,"type":"response","id":"${request.id}","ok":true,"result":{"takeoverRequired":true,"token":"$token"}}""") as ServerFrame.Response
        assertEquals(token, frame.takeoverToken)
        assertEquals("call", ledger.response(frame.id))
        assertThrows(ProtocolFailure::class.java) { ledger.response(frame.id) }
        for (result in listOf(
            """{"takeoverRequired":false,"token":"$token"}""",
            """{"takeoverRequired":true,"token":"short"}""",
            """{"takeoverRequired":true,"token":"${"!".repeat(43)}"}""",
            """{"takeoverRequired":true,"token":"$token","extra":1}""",
        )) assertThrows(ProtocolFailure::class.java) {
            parseFrame("""{"v":3,"type":"response","id":"1","ok":true,"result":$result}""")
        }
    }
}
