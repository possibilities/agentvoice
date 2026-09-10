package com.arthack.agentvoice

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class StudioBindingStoreTest {
    private fun directory() = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
        "studio-binding-${UUID.randomUUID()}").also { it.mkdirs() }

    @Test fun absentBindingIsCreatedOnceAndReusedExactly() {
        val dir = directory()
        try {
            val file = File(dir, "persona-studio-binding.json")
            val profile = File(dir, "persona-tuning.json").also { it.writeText("saved-profile") }
            val draft = File(dir, "persona-studio-draft.json").also { it.writeText("working-draft") }
            val first = StudioBindingStore(file).loadOrCreate()
            assertTrue(first.name.matches(Regex("agentvoice-halo-[a-f0-9]{32}")))
            assertTrue(first.token.matches(Regex("[a-f0-9]{64}")))
            val bytes = file.readBytes()
            assertEquals(setOf("socket", "token"), JSONObject(bytes.toString(Charsets.UTF_8)).fields())
            assertEquals(first, StudioBindingStore(file).loadOrCreate())
            assertArrayEquals(bytes, file.readBytes())
            assertEquals("saved-profile", profile.readText())
            assertEquals("working-draft", draft.readText())
            assertEquals(listOf("persona-studio-binding.json", "persona-studio-draft.json", "persona-tuning.json"),
                dir.list()?.sorted()?.toList())
        } finally { dir.deleteRecursively() }
    }

    @Test fun validExistingBindingIsReturnedWithoutChangingBytes() {
        val dir = directory()
        try {
            val file = File(dir, "persona-studio-binding.json")
            val expected = PersonaPreviewBinding("agentvoice-halo-${"12".repeat(16)}", "ab".repeat(32))
            file.writeText(expected.json().toString(2))
            val bytes = file.readBytes()
            assertEquals(expected, StudioBindingStore(file).loadOrCreate())
            assertArrayEquals(bytes, file.readBytes())
            assertEquals("PersonaPreviewBinding(redacted)", expected.toString())
        } finally { dir.deleteRecursively() }
    }

    @Test fun malformedExistingBindingFailsClosedWithoutReplacementOrSecretDisclosure() {
        val invalid = listOf(
            "broken",
            JSONObject().put("socket", "agentvoice-halo-${"12".repeat(16)}").put("token", "secret-token").toString(),
            JSONObject().put("socket", "agentvoice-halo-${"12".repeat(16)}").put("token", "ab".repeat(32)).put("extra", true).toString(),
        )
        for (text in invalid) {
            val dir = directory()
            try {
                val file = File(dir, "persona-studio-binding.json").also { it.writeText(text) }
                val failure = assertThrows(StudioBindingException::class.java) { StudioBindingStore(file).loadOrCreate() }
                assertEquals(text, file.readText())
                assertFalse(failure.message.orEmpty().contains("secret-token"))
                assertEquals(setOf("persona-studio-binding.json"), dir.list()?.toSet())
            } finally { dir.deleteRecursively() }
        }
    }
}
