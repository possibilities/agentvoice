package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class ShippingProfileTest {
    private val appearanceFields = setOf("theme", "mutedPresence", "mutedTuning", "presenceScope", "showPushToTalk", "icons", "launcher")
    private val portrait = PreviewLayout(
        placement = PersonaPlacement(.51f, .62f, .73f, (-39).dp),
        design = PreviewDesign(controlsHeightDp = 418, holdSharePercent = 49.0, controlsWithoutPttDp = 609),
        halo = PreviewHalo(variant = "contained", containedSizePercent = 65, ringSpreadPercent = 61),
        spirit = PreviewSpirit("soft", 58, "follow"), horizontalOffsetDp = -13,
    )
    private val landscape = portrait.copy(
        placement = PersonaPlacement(.84f, .91f, .67f, 28.dp),
        design = portrait.design.copy(controlsHeightDp = 731, holdSharePercent = 34.0, controlsWithoutPttDp = 1024),
        halo = portrait.halo.copy(containedSizePercent = 93, ringSpreadPercent = 18, speakingColor = "#123abc"),
        spirit = portrait.spirit.copy(strengthPercent = 82), personaSide = "right", horizontalOffsetDp = 37,
        appearanceOverrides = setOf("halo", "spirit"),
    )
    private val sounds = PreviewSounds("rocker-29", 83)

    private fun appearance(channels: String = "noun-icons") = DesignAppearance(
        theme = "grayscale", mutedPresence = "contacts",
        mutedTuning = PreviewMutedTuning(26, -31, 177, 47, 23, "ripple"),
        presenceScope = "both-muted", showPushToTalk = false, icons = PreviewIcons(channels, "contact"), launcher = "relay-aperture",
    )

    private fun file() = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
        "shipping-profile-${UUID.randomUUID()}.json")

    private fun session(file: File, layouts: PreviewProfileLayouts = PreviewProfileLayouts(
        portrait, landscape, PreviewSharedAppearance.from(portrait)), selectedSounds: PreviewSounds = sounds): PersonaPreviewSession {
        val p = layouts.portrait
        return PersonaPreviewSession(p.placement, file, p.design, p.halo, p.spirit, layouts.landscape,
            p.personaSide, p.horizontalOffsetDp, p.appearanceOverrides, layouts.shared, selectedSounds)
    }

    private suspend fun reload(file: File): PersonaPreviewSession {
        val text = file.readText()
        val layouts = decodePreviewProfileLayouts(text)
        val selectedSounds = decodePersonaSounds(text)
        val selectedAppearance = decodeDesignAppearanceProfile(text)
        return withContext(Dispatchers.Main) {
            session(file, layouts, selectedSounds).also {
                it.state = it.state.withAppearance(selectedAppearance).copy(savedAppearance = selectedAppearance)
            }
        }
    }

    private fun preview(state: PersonaPreviewState) = state.activeLayout().json()
        .put("id", 1).put("method", "preview").put("mode", state.mode).put("connection", state.connection)
        .put("activity", state.activity).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)
        .put("theme", state.theme).put("mutedPresence", state.mutedPresence).put("mutedTuning", state.mutedTuning.json())
        .put("presenceScope", state.presenceScope).put("showPushToTalk", state.showPushToTalk)
        .put("icons", state.icons.json()).put("launcher", state.launcher).put("sounds", state.sounds.json())

    private fun save(state: PersonaPreviewState) = JSONObject().put("id", 2).put("method", "save")
        .put("revision", state.revision).put("orientation", state.orientation).put("orientationEpoch", state.orientationEpoch)

    private fun fixture(selected: DesignAppearance) = encodePersonaTuning(portrait.placement, portrait.design,
        portrait.halo, portrait.spirit, landscape, portrait.personaSide, portrait.horizontalOffsetDp,
        portrait.appearanceOverrides, PreviewSharedAppearance.from(portrait), sounds, selected)

    private fun assertAppearance(expected: DesignAppearance, actual: DesignAppearance) {
        assertEquals(expected.theme, actual.theme)
        assertEquals(expected.mutedPresence, actual.mutedPresence)
        assertEquals(expected.mutedTuning, actual.mutedTuning)
        assertEquals(expected.presenceScope, actual.presenceScope)
        assertEquals(expected.showPushToTalk, actual.showPushToTalk)
        assertEquals(expected.icons, actual.icons)
        assertEquals(expected.launcher, actual.launcher)
    }

    private fun assertLayouts(state: PersonaPreviewState) {
        val p = if (state.orientation == "portrait") state else state.rotate("portrait")
        assertEquals(portrait, p.activeLayout())
        assertEquals(landscape, p.otherLayout)
        assertEquals(portrait, p.savedLayout())
        assertEquals(landscape, p.savedOtherLayout)
        assertEquals(sounds, p.sounds)
        assertEquals(sounds, p.savedSounds)
    }

    @Test fun saveAndReloadRetainEveryAppearanceChoiceAndBothOrientationLayouts() = runBlocking {
        for (family in listOf("noun-boatman", "noun-icons")) {
            val file = file()
            try {
                val session = withContext(Dispatchers.Main) { session(file) }
                val before = withContext(Dispatchers.Main) { session.state }
                val chosen = appearance(family)
                session.command(preview(before.withAppearance(chosen)).put("connection", "connecting")
                    .put("mode", "idle").put("activity", "voice"))
                val edited = withContext(Dispatchers.Main) { session.state }
                assertAppearance(chosen, edited.appearance())
                assertAppearance(before.savedAppearance, edited.savedAppearance)
                assertFalse(edited.showPushToTalk)
                assertFalse(file.exists())
                withContext(Dispatchers.Main) { session.state = session.state.rotate("landscape") }
                val selected = withContext(Dispatchers.Main) { session.state }
                assertAppearance(chosen, selected.appearance())
                val reply = session.command(save(selected))
                val text = reply.getString("profile")
                val profile = JSONObject(text)
                assertEquals(20, profile.getInt("version"))
                assertEquals(text, file.readText())
                assertAppearance(chosen, decodeDesignAppearanceProfile(text))
                assertEquals(portrait, decodePreviewProfileLayouts(text).portrait)
                assertEquals(landscape, decodeLandscapeLayout(text))
                for (key in appearanceFields) {
                    assertTrue("Appearance is durable at the root: $key", profile.has(key))
                    assertFalse(profile.getJSONObject("landscape").has(key))
                    assertFalse(profile.getJSONObject("sharedAppearance").has(key))
                }
                val saved = withContext(Dispatchers.Main) { session.state }
                assertAppearance(chosen, saved.savedAppearance)
                assertLayouts(saved)
                assertEquals(24, reply.getJSONObject("state").getInt("protocol"))
                assertAppearance(chosen, decodeDesignAppearance(reply.getJSONObject("state").getJSONObject("savedAppearance")))
                val loaded = reload(file)
                val restored = withContext(Dispatchers.Main) { loaded.state }
                assertAppearance(chosen, restored.appearance())
                assertAppearance(chosen, restored.savedAppearance)
                assertLayouts(restored)
                assertEquals("connected", restored.connection)
                assertEquals("speaking", restored.mode)
                assertEquals("steady", restored.activity)
                assertEquals(0, restored.revision)
                assertEquals(0, restored.orientationEpoch)
                assertEquals(text, file.readText())
            } finally { file.delete() }
        }
    }

    @Test fun resettingAppearanceChangesOnlyThePreviewUntilExplicitSave() = runBlocking {
        val file = file()
        try {
            val session = withContext(Dispatchers.Main) { session(file) }
            val initial = withContext(Dispatchers.Main) { session.state }
            val chosen = appearance()
            session.command(preview(initial.withAppearance(chosen)))
            val selected = withContext(Dispatchers.Main) { session.state }
            val savedText = session.command(save(selected)).getString("profile")
            val saved = withContext(Dispatchers.Main) { session.state }
            val defaults = decodeDesignAppearance(saved.json().getJSONObject("defaultAppearance"))
            assertAppearance(shippingAppearance(), defaults)
            session.command(preview(saved.withAppearance(defaults)))
            val reset = withContext(Dispatchers.Main) { session.state }
            assertAppearance(defaults, reset.appearance())
            assertAppearance(chosen, reset.savedAppearance)
            assertLayouts(reset)
            assertEquals(savedText, file.readText())
            val beforeSave = reload(file)
            assertAppearance(chosen, withContext(Dispatchers.Main) { beforeSave.state.appearance() })
            val resetText = session.command(save(reset)).getString("profile")
            assertEquals(resetText, file.readText())
            val afterSave = reload(file)
            val loaded = withContext(Dispatchers.Main) { afterSave.state }
            assertAppearance(defaults, loaded.appearance())
            assertAppearance(defaults, loaded.savedAppearance)
            assertLayouts(loaded)
        } finally { file.delete() }
    }

    @Test fun profileEighteenUsesHistoricalAppearanceWithoutChangingSavedBytesOrLayouts() = runBlocking {
        val file = file()
        try {
            val legacy = JSONObject(fixture(appearance())).put("version", 18).apply {
                for (key in appearanceFields) remove(key)
            }.toString(2)
            file.writeText(legacy)
            val historical = DesignAppearance("bright", "tide", PreviewMutedTuning(14, 0, 100, 0, 14, "float"),
                "any-muted", true, PreviewIcons("current", "current"))
            val loaded = reload(file)
            val restored = withContext(Dispatchers.Main) { loaded.state }
            assertAppearance(historical, restored.appearance())
            assertAppearance(historical, restored.savedAppearance)
            assertLayouts(restored)
            assertEquals(legacy, file.readText())
            val migrated = loaded.command(save(restored)).getString("profile")
            assertEquals(20, JSONObject(migrated).getInt("version"))
            assertAppearance(historical, decodeDesignAppearanceProfile(migrated))
            assertEquals(portrait, decodePreviewProfileLayouts(migrated).portrait)
            assertEquals(landscape, decodeLandscapeLayout(migrated))
        } finally { file.delete() }
    }

    @Test fun profileTwentyRequiresCompleteValidAppearance() {
        val complete = fixture(appearance())
        for (key in appearanceFields) {
            val missing = JSONObject(complete).apply { remove(key) }
            assertTrue("Missing $key must not silently adopt defaults", runCatching {
                decodeDesignAppearanceProfile(missing.toString())
            }.isFailure)
        }
        val invalid = listOf(
            "launcher" to "unknown", "launcher" to JSONObject.NULL, "theme" to "unknown", "mutedPresence" to "unknown", "presenceScope" to "unknown",
            "showPushToTalk" to "false", "showPushToTalk" to JSONObject.NULL,
            "icons" to appearance().icons.json().put("channels", "unknown"),
            "icons" to appearance().icons.json().apply { remove("push") },
            "icons" to appearance().icons.json().put("extra", true),
            "mutedTuning" to appearance().mutedTuning.json().put("cycleSeconds", 31),
            "mutedTuning" to appearance().mutedTuning.json().put("driftPercent", 2.5),
            "mutedTuning" to appearance().mutedTuning.json().apply { remove("motion") },
            "mutedTuning" to appearance().mutedTuning.json().put("extra", true),
        )
        for ((key, value) in invalid) assertTrue("Reject invalid $key=$value", runCatching {
            decodeDesignAppearanceProfile(JSONObject(complete).put(key, value).toString())
        }.isFailure)
    }

    @Test fun savingAHeldSyntheticCallCannotPersistItsSessionOrGateState() = runBlocking {
        val file = file()
        try {
            val session = withContext(Dispatchers.Main) {
                session(file).also {
                    it.state = it.state.withAppearance(appearance().copy(showPushToTalk = true))
                        .copy(activity = "voice", speakerMuted = true).beginHold().rotate("landscape").beginHold()
                }
            }
            val held = withContext(Dispatchers.Main) { session.state }
            assertTrue(held.holding)
            assertTrue(held.micMuted)
            assertTrue(held.speakerMuted)
            assertEquals("listening", held.mode)
            val text = session.command(save(held)).getString("profile")
            val forbidden = setOf("connection", "mode", "activity", "holding", "micMuted", "speakerMuted",
                "micOpen", "speakerOpen", "canHold", "running", "controlsPending", "outputLevel", "revision",
                "orientation", "orientationEpoch", "previewSocket", "previewToken", "previewState", "protocol")
            fun checkFields(value: Any) {
                when (value) {
                    is JSONObject -> for (key in value.fields()) {
                        assertFalse("Synthetic field leaked into the profile: $key", key in forbidden)
                        checkFields(value.get(key))
                    }
                    is JSONArray -> for (index in 0 until value.length()) checkFields(value.get(index))
                }
            }
            checkFields(JSONObject(text))
            val loaded = reload(file)
            val restored = withContext(Dispatchers.Main) { loaded.state }
            assertFalse(restored.holding)
            assertTrue(restored.micMuted)
            assertFalse(restored.speakerMuted)
            assertEquals("speaking", restored.mode)
            assertEquals("steady", restored.activity)
            assertEquals("portrait", restored.orientation)
            assertEquals(0, restored.revision)
            assertEquals(0, restored.orientationEpoch)
            assertAppearance(held.appearance(), restored.appearance())
            assertLayouts(restored)
        } finally { file.delete() }
    }
    @Test fun legacyNineteenKeepsAppearanceAndSeedsCurrentLauncherWithoutRewriting() {
        val previous = JSONObject(fixture(appearance())).put("version", 19).apply { remove("launcher") }.toString()
        assertAppearance(appearance().copy(launcher = "current"), decodeDesignAppearanceProfile(previous))
        val restored = PersonaPreviewState().withAppearance(appearance()).json().put("protocol", 22).apply {
            remove("launcher")
            getJSONObject("savedAppearance").remove("launcher")
            getJSONObject("defaultAppearance").remove("launcher")
        }
        assertEquals("current", restorePersonaPreview(restored, portrait.placement).launcher)
        assertFalse(JSONObject(previous).has("launcher"))
    }

}
