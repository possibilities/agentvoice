package com.arthack.agentvoice

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class StudioDraftTest {
    private fun directory() = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
        "studio-draft-${UUID.randomUUID()}").also { it.mkdirs() }
    private fun design(profile: String) = PersonaPreviewState().withDesignProfile(profile).designProfile()
    private fun edited(): PersonaPreviewState {
        val base = PersonaPreviewState().withDesignProfile(StudioProduction.profile)
        val other = base.otherLayout.copy(personaSide = "right", horizontalOffsetDp = 49,
            halo = base.otherLayout.halo.copy(ringSpreadPercent = 17), appearanceOverrides = setOf("halo"),
            design = base.otherLayout.design.copy(controlsWithoutPttDp = 743))
        return base.copy(otherLayout = other, sounds = PreviewSounds("rocker-29", 39), launcher = "duplex-halo",
            theme = "grayscale", icons = PreviewIcons("engraved", "contact"), showPushToTalk = false,
            mutedPresence = "labeled", presenceScope = "always", mutedTuning = PreviewMutedTuning(27, -43, 156, 55, 19, "ripple"))
    }

    @Test fun restartRetainsCompleteDraftAndInheritanceWithoutTouchingSavedCheckpoint() {
        val dir = directory()
        try {
            val file = File(dir, "draft.json")
            val checkpoint = File(dir, "persona-tuning.json").also { it.writeText("operator checkpoint") }
            val store = StudioDraft(file)
            assertEquals(design(StudioProduction.profile), design(store.open()))
            val chosen = edited().rotate("landscape").designProfile()
            store.write(chosen)
            assertEquals(chosen, design(StudioDraft(file).open()))
            assertEquals("operator checkpoint", checkpoint.readText())
            assertEquals(setOf("halo"), decodePreviewProfileLayouts(chosen).landscape.appearanceOverrides)
        } finally { dir.deleteRecursively() }
    }

    @Test fun productionChangeSeedsOnceAndArchivesPriorDraftEvenWithIdenticalProductionValues() {
        val dir = directory()
        try {
            val file = File(dir, "draft.json")
            StudioDraft(file, "release-a").apply { open(); write(edited().designProfile()) }
            val previous = file.readText()
            val next = StudioDraft(file, "release-b")
            assertEquals(design(StudioProduction.profile), design(next.open()))
            assertEquals(previous, File(file.path + ".previous").readText())
            next.write(edited().designProfile())
            assertEquals(edited().designProfile(), design(StudioDraft(file, "release-b").open()))
        } finally { dir.deleteRecursively() }
    }

    @Test fun resetIsAtomicAcrossOrientationsDurableAndDoesNotSaveTheCheckpoint() = runBlocking {
        val dir = directory()
        try {
            val file = File(dir, "draft.json")
            val checkpoint = File(dir, "selection.json").also { it.writeText("retained") }
            val store = StudioDraft(file).also { it.open() }
            val session = withContext(Dispatchers.Main) {
                PersonaPreviewSession(PersonaPlacement(), checkpoint, persistDesign = store::write).also {
                    it.state = edited().rotate("landscape")
                }
            }
            val before = withContext(Dispatchers.Main) { session.state }
            val request = JSONObject().put("id", 1).put("method", "resetProduction").put("revision", before.revision)
                .put("orientation", before.orientation).put("orientationEpoch", before.orientationEpoch)
            session.command(request)
            val after = withContext(Dispatchers.Main) { session.state }
            assertEquals("landscape", after.orientation)
            assertEquals(before.orientationEpoch, after.orientationEpoch)
            assertEquals(before.savedAppearance, after.savedAppearance)
            assertEquals(before.savedOtherLayout, after.savedOtherLayout)
            assertEquals(design(StudioProduction.profile), after.designProfile())
            assertEquals(after.designProfile(), design(StudioDraft(file).open()))
            assertEquals("retained", checkpoint.readText())
            assertTrue(runCatching { session.command(request) }.isFailure)
        } finally { dir.deleteRecursively() }
    }

    @Test fun rejectedDiskWriteDoesNotPublishAnUndurablePreview() = runBlocking {
        val dir = directory()
        try {
            val session = withContext(Dispatchers.Main) {
                PersonaPreviewSession(PersonaPlacement(), File(dir, "checkpoint"), persistDesign = { error("disk full") })
            }
            val before = withContext(Dispatchers.Main) { session.state }
            assertTrue(runCatching { withContext(Dispatchers.Main) { session.state = edited() } }.isFailure)
            assertEquals(before, withContext(Dispatchers.Main) { session.state })
        } finally { dir.deleteRecursively() }
    }

    @Test fun persistedDesignExcludesRehearsalAndCapabilitiesAndRotationAloneDoesNotWrite() {
        val dir = directory()
        try {
            val file = File(dir, "draft.json")
            val store = StudioDraft(file).also { it.open() }
            val held = edited().copy(showPushToTalk = true, activity = "voice", speakerMuted = true, micMuted = true).beginHold()
            store.write(held.designProfile())
            val bytes = file.readText()
            store.write(held.rotate("landscape").designProfile())
            assertEquals(bytes, file.readText())
            val profile = JSONObject(bytes).getJSONObject("profile")
            for (key in listOf("holding", "mode", "activity", "connection", "micMuted", "speakerMuted", "orientation",
                "orientationEpoch", "revision", "previewSocket", "previewToken")) assertFalse(key, profile.has(key))
            val restored = PersonaPreviewState().withDesignProfile(StudioDraft(file).open())
            assertFalse(restored.holding)
            assertEquals("steady", restored.activity)
            assertEquals("speaking", restored.mode)
        } finally { dir.deleteRecursively() }
    }

    @Test fun unreadableDraftIsReportedAndRetainedRatherThanSilentlyOverwritten() {
        val dir = directory()
        try {
            val file = File(dir, "draft.json").also { it.writeText("broken draft") }
            assertTrue(runCatching { StudioDraft(file).open() }.isFailure)
            assertEquals("broken draft", file.readText())
        } finally { dir.deleteRecursively() }
    }
}
