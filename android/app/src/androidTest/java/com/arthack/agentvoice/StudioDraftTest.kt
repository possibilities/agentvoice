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
            halo = base.otherLayout.halo.copy(ringSpreadPercent = 17, thinkingWingspan = 8), appearanceOverrides = setOf("halo"),
            design = base.otherLayout.design.copy(controlsWithoutPttDp = 743))
        return base.copy(otherLayout = other, sounds = PreviewSounds("rocker-29", 39), launcher = "duplex-halo", connectionStyle = "datum",
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
            assertEquals(8, decodePreviewProfileLayouts(chosen).landscape.halo.thinkingWingspan)
        } finally { dir.deleteRecursively() }
    }

    @Test fun newProductionAndLegacyMarkersNeverReplaceAnExistingDraft() {
        val dir = directory()
        try {
            val file = File(dir, "draft.json")
            val chosen = edited().designProfile()
            for (version in listOf(1, 2)) {
                val stored = JSONObject().put("version", version).put("profile", JSONObject(chosen))
                if (version == 1) stored.put("productionGeneration", "older-production")
                file.writeText(stored.toString())
                val previous = file.readText()
                assertEquals(chosen, design(StudioDraft(file, StudioProduction.profile).open()))
                assertEquals(previous, file.readText())
                assertFalse(File(file.path + ".previous").exists())
            }
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

    @Test fun versionTwoDraftMigratesReverseSlotsOnlyAfterTheNextEdit() {
        val dir = directory()
        try {
            val file = File(dir, "draft.json")
            val current = JSONObject(edited().designProfile())
            val legacy = JSONObject(current.toString()).withoutThinkingWingspan().put("version", 20).apply {
                remove("connectionStyle")
                remove("portraitReverse")
                remove("landscapeReverse")
            }
            file.writeText(JSONObject().put("version", 2).put("profile", legacy).toString())
            val original = file.readText()
            val store = StudioDraft(file)
            val opened = store.open()
            assertEquals(original, file.readText())
            val migrated = PersonaPreviewState().withDesignProfile(opened)
            assertEquals(migrated.layouts().getValue(previewPortrait), migrated.layouts().getValue(previewPortraitReverse))
            assertEquals(migrated.layouts().getValue(previewLandscape), migrated.layouts().getValue(previewLandscapeReverse))
            store.write(migrated.copy(horizontalOffsetDp = 17).designProfile())
            val saved = JSONObject(file.readText())
            assertEquals(3, saved.getInt("version"))
            assertEquals(23, saved.getJSONObject("profile").getInt("version"))
            assertTrue(saved.getJSONObject("profile").has("portraitReverse"))
            assertTrue(saved.getJSONObject("profile").has("landscapeReverse"))
        } finally { dir.deleteRecursively() }
    }
}
