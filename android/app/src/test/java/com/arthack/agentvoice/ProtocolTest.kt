package com.arthack.agentvoice

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    private val id = "11111111-1111-4111-8111-111111111111"
    private fun rejected(block: () -> Unit) { assertThrows(ProtocolFailure::class.java, block) }
    private fun profile(endpoint: String) = buildJsonObject {
        put("version", 1); put("endpoint", endpoint); put("token", "a".repeat(32) + "." + "b".repeat(64))
    }.toString()

    @Test fun sharedServerContractFixturesAgreeWithTheAndroidDecoder() {
        val fixtures = javaClass.getResourceAsStream("/server-frames.json")!!.bufferedReader().use { jsonObject(it.readText()) }
        (fixtures["valid"] as JsonArray).forEach { parseFrame(it.toString()) }
        (fixtures["invalid"] as JsonArray).forEach { rejected { parseFrame(it.toString()) } }
    }
    @Test fun deeplyNestedHostileJsonIsRejectedBeforeRecursiveParsing() {
        rejected { parseFrame("[".repeat(10_000) + "]".repeat(10_000)) }
    }

    @Test fun grantsRequireExactTlsEndpointAndNeverPrintSecrets() {
        val grant = DeviceGrant.parse(profile("wss://desktop.example.ts.net:48414/v2/client"))
        assertEquals("DeviceGrant(redacted)", grant.toString())
        for (endpoint in listOf("ws://host/v2/client", "https://host/v2/client", "wss://user:secret@host/v2/client",
            "wss://host/v2/client?token=secret", "wss://host/v2/client#secret", "wss://host/other",
            "wss://host/v2/client/", "wss://host:0/v2/client", "wss://host:65536/v2/client")) {
            rejected { DeviceGrant.parse(profile(endpoint)) }
        }
        rejected { DeviceGrant.parse(profile("wss://host/v2/client").replace("\"version\":1", "\"version\":2")) }
        rejected { DeviceGrant.parse(profile("wss://host/v2/client").dropLast(1) + ",\"extra\":true}") }
    }
    @Test fun everyOwnerMessageHasStrictFieldsAndTypes() {
        assertEquals(ServerFrame.Ping("a".repeat(32)), parseFrame("""{"v":2,"type":"ping","nonce":"${"a".repeat(32)}"}"""))
        for (type in listOf("prepare", "close")) {
            assertEquals(ServerFrame.Media(type, id), parseFrame("""{"v":2,"type":"client-media","message":{"type":"$type","sessionId":"$id"}}"""))
        }
        assertEquals(ServerFrame.Response("1", true), parseFrame("""{"v":2,"type":"response","id":"1","ok":true,"result":null}"""))
        assertEquals(ServerFrame.Response("1", false), parseFrame("""{"v":2,"type":"response","id":"1","ok":false,"error":{"message":"refused"}}"""))
        val invalid = listOf("[]", "null", "{'v':2}", """{"v":1,"type":"ping","nonce":"${"a".repeat(32)}"}""",
            """{"v":"2","type":"ping","nonce":"${"a".repeat(32)}"}""",
            """{"v":2,"type":"ping","nonce":"bad"}""", """{"v":2,"type":"pong","nonce":"${"a".repeat(32)}"}""",
            """{"v":2,"type":"response","id":"1","ok":"true","result":null}""",
            """{"v":2,"type":"response","id":"1","ok":true,"result":null,"extra":1}""",
            """{"v":2,"type":"client-media","message":{"type":"answer","sessionId":"$id","sdp":""}}""",
            """{"v":2,"type":"client-media","message":{"type":"prepare","sessionId":"wrong"}}""")
        invalid.forEach { value -> rejected { parseFrame(value) } }
    }
    @Test fun byteAndSdpLimitsAreNotCharacterByteConfusion() {
        val frame = """{"v":2,"type":"client-media","message":{"type":"answer","sessionId":"$id","sdp":"${"x".repeat(MAX_SDP_CHARS)}"}}"""
        assertTrue(parseFrame(frame) is ServerFrame.Media)
        rejected { parseFrame(frame.replace("\"sdp\":\"", "\"sdp\":\"x")) }
        rejected { parseFrame("世".repeat(MAX_FRAME_BYTES / 3 + 1)) }
    }
    @Test fun requestBoundsCorrelationAndTimeoutsFailClosed() {
        var now = 0L
        val ledger = WireLedger { now }
        repeat(32) { ledger.request("input", command("release")) }
        rejected { ledger.request("input", command("release")) }
        assertEquals("input", ledger.response("1"))
        rejected { ledger.response("1") }
        rejected { ledger.response("unsolicited") }
        now = 29_999
        ledger.checkLiveness()
        now = 30_000
        rejected { ledger.checkLiveness() }
    }
    @Test fun ordinaryTrafficDoesNotKeepADeadHeartbeatAlive() {
        var now = 0L
        val ledger = WireLedger { now }
        now = 20_000
        val request = ledger.request("input", command("release"))
        ledger.response(request.id)
        ledger.receive()
        now = 30_000
        rejected { ledger.checkLiveness() }
    }
    @Test fun pingRestoresLivenessAndRateWindowIsBounded() {
        var now = 0L
        val ledger = WireLedger { now }
        now = 20_000
        assertTrue(ledger.pong("a".repeat(32)).contains("pong"))
        now = 40_000
        ledger.checkLiveness()
        repeat(256) { ledger.receive() }
        rejected { ledger.receive() }
        now += 10_000
        ledger.receive()
    }
}
