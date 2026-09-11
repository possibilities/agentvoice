package com.arthack.agentvoice

import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.descendants
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

class PreviewIconsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun request(state: PersonaPreviewState) = state.activeLayout().json()
        .put("method", "preview").put("id", 1).put("orientation", state.orientation)
        .put("orientationEpoch", state.orientationEpoch).put("mode", state.mode).put("connection", state.connection)
        .put("activity", state.activity).put("theme", state.theme).put("mutedPresence", state.mutedPresence)
        .put("mutedTuning", state.mutedTuning.json()).put("presenceScope", state.presenceScope)
        .put("sounds", state.sounds.json()).put("showPushToTalk", state.showPushToTalk).put("icons", state.icons.json()).put("launcher", state.launcher).put("connectionStyle", state.connectionStyle)

    @Test fun iconChoicesSurviveRotationAndPersistOnlyOnExplicitSave() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "icons-${UUID.randomUUID()}.json")
        val session = PersonaPreviewSession(defaultPortraitLayout().placement, file)
        suspend fun state() = withContext(Dispatchers.Main) { session.state }
        try {
            val before = state()
            val savedBytes = encodePersonaTuning(before.placement, before.design).toByteArray()
            file.writeBytes(savedBytes)
            for (family in previewIconFamilies) for (push in previewPushIcons) {
                val selected = PreviewIcons(family, push)
                session.command(request(state()).put("icons", selected.json()))
                val next = state()
                assertEquals(selected, next.icons)
                assertEquals(selected, next.rotate("landscape").icons)
                assertEquals(selected, restorePersonaPreview(next.json(), next.saved).icons)
                assertEquals(before.activeLayout(), next.activeLayout())
                assertEquals(before.otherLayout, next.otherLayout)
                assertArrayEquals(savedBytes, file.readBytes())
            }
            for (bad in listOf(JSONObject(), PreviewIcons().json().put("extra", true),
                PreviewIcons().json().put("channels", "unknown"), PreviewIcons().json().put("push", "unknown"))) {
                val beforeInvalid = state()
                assertTrue(runCatching { session.command(request(beforeInvalid).put("icons", bad)) }.isFailure)
                assertEquals(beforeInvalid, state())
            }
            val beforeCredits = state()
            session.command(JSONObject().put("method", "iconCredits").put("id", 3))
            assertTrue(withContext(Dispatchers.Main) { session.showIconCredits })
            assertEquals(beforeCredits.endHold(), state())
            assertArrayEquals(savedBytes, file.readBytes())
            val selected = state()
            val legacy = selected.json().withoutThinkingWingspan().put("protocol", 20).apply { remove("icons") }
            assertEquals(PreviewIcons(), restorePersonaPreview(legacy, selected.saved).icons)
            val reply = session.command(JSONObject().put("method", "save").put("id", 2)
                .put("revision", selected.revision).put("orientation", selected.orientation)
                .put("orientationEpoch", selected.orientationEpoch))
            val profile = JSONObject(reply.getString("profile"))
            assertEquals(23, profile.getInt("version"))
            assertEquals(selected.icons, decodePreviewIcons(profile.getJSONObject("icons")))
            assertEquals(selected.icons, state().icons)
            assertEquals(30, reply.getJSONObject("state").getInt("protocol"))
        } finally { file.delete() }
    }

    @Test fun nativeCreditsAreReadableAndDismissible() {
        var open by mutableStateOf(true)
        compose.setContent { VoiceTheme { if (open) PreviewIconCredits { open = false } } }
        compose.onNodeWithText("Design icon credits").assertIsDisplayed()
        compose.onNodeWithText("Microphone by Edward Boatman", substring = true).assertExists()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Design icon credits").assertDoesNotExist()
    }

    @Test fun mutedClearanceIsActuallyTransparentInCompose() {
        var selected by mutableStateOf("engraved")
        var muted by mutableStateOf(true)
        var speaker by mutableStateOf(false)
        val ground = Color(0xFF3F0D42)
        compose.setContent {
            CompositionLocalProvider(LocalPreviewIcons provides PreviewIcons(channels = selected)) {
                Box(Modifier.size(160.dp).background(ground).testTag("icon-knockout")) {
                    Image(previewChannelPainter(speaker, muted)!!, contentDescription = null,
                        modifier = Modifier.fillMaxSize(), colorFilter = ColorFilter.tint(VoiceInk.you))
                }
            }
        }
        for (family in listOf("engraved", "noun-boatman", "noun-icons")) {
            compose.runOnIdle { selected = family; muted = true }
            val pixels = compose.onNodeWithTag("icon-knockout").captureToImage().toPixelMap()
            fun pixel(x: Float, y: Float) = pixels[(pixels.width * x / 24f).toInt(), (pixels.height * y / 24f).toInt()].toArgb()
            val cutX = if (family == "engraved") 10.5f else 10.55f
            val cutY = if (family == "engraved") 13f else 8.25f
            assertEquals("$family mute knockout reveals the actual surface under uniform tint", ground.toArgb(), pixel(cutX, cutY))
            assertEquals("$family remaining glyph takes channel tint", VoiceInk.you.toArgb(),
                if (family == "engraved") pixel(12f, 3f) else pixel(10.55f, 5.55f))
            compose.runOnIdle { muted = false }
            val live = compose.onNodeWithTag("icon-knockout").captureToImage().toPixelMap()
            assertEquals("$family cutout sample crosses the original glyph", VoiceInk.you.toArgb(),
                live[(live.width * cutX / 24f).toInt(), (live.height * cutY / 24f).toInt()].toArgb())
        }
        compose.runOnIdle { selected = "noun-boatman"; muted = true; speaker = true }
        val cleaned = compose.onNodeWithTag("icon-knockout").captureToImage().toPixelMap()
        fun cleanedPixel(x: Float, y: Float) = cleaned[(cleaned.width * x / 24f).toInt(), (cleaned.height * y / 24f).toInt()].toArgb()
        assertEquals("Detached lower wave fragment is transparent", ground.toArgb(), cleanedPixel(12.85f, 17.05f))
        assertEquals("Upper speaker wave remains intact", VoiceInk.you.toArgb(), cleanedPixel(20.95f, 11.55f))
        compose.runOnIdle { muted = false }
        val liveSpeaker = compose.onNodeWithTag("icon-knockout").captureToImage().toPixelMap()
        assertEquals("Live speaker retains the original wave", VoiceInk.you.toArgb(),
            liveSpeaker[(liveSpeaker.width * 12.85f / 24f).toInt(), (liveSpeaker.height * 17.05f / 24f).toInt()].toArgb())

    }

    @Test fun iconChangesKeepNativePersonaAndHeldPointerWhilePreservingChannelTruth() {
        compose.mainClock.autoAdvance = false
        var icons by mutableStateOf(PreviewIcons())
        var ui by mutableStateOf(CallUi(connected = true, micMuted = true, speakerOpen = true, canHold = true))
        var starts = 0
        var stops = 0
        compose.setContent {
            VoiceTheme {
                PreviewStudioScreen(ui, defaultPortraitLayout().design, defaultPortraitLayout().placement,
                    {}, { starts++; ui = ui.copy(holding = true, micOpen = true) },
                    { stops++; ui = ui.copy(holding = false, micOpen = false) }, {},
                    halo = PreviewHalo(variant = "contained"), mutedPresence = "channels", presenceScope = "always", icons = icons)
            }
        }
        compose.mainClock.advanceTimeBy(800)
        val tags = listOf("mic-mute", "speaker-mute", "hold-to-talk", "studio-persona-stage")
        val bounds = tags.map { compose.onNodeWithTag(it, useUnmergedTree = true).getUnclippedBoundsInRoot() }
        val native = compose.runOnIdle {
            (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<CompactHaloAnimationView>().single()
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { down(center) }
        for (family in previewIconFamilies) for (push in previewPushIcons) {
            compose.runOnIdle { icons = PreviewIcons(family, push) }
            compose.mainClock.advanceTimeBy(32)
            assertEquals(bounds, tags.map { compose.onNodeWithTag(it, useUnmergedTree = true).getUnclippedBoundsInRoot() })
            compose.onNodeWithTag("mic-mute").assertContentDescriptionEquals("HUMAN microphone")
            compose.onNodeWithTag("speaker-mute").assertContentDescriptionEquals("AGENT speaker")
            compose.runOnIdle {
                assertEquals(1, starts); assertEquals(0, stops)
                assertTrue(ui.micMuted && ui.micOpen && ui.holding)
                assertSame(native, (compose.activity.window.decorView as ViewGroup).descendants.filterIsInstance<CompactHaloAnimationView>().single())
            }
        }
        compose.onNodeWithTag("hold-to-talk").performTouchInput { up() }
        compose.runOnIdle { assertEquals(1, stops); assertFalse(ui.micOpen); assertTrue(ui.micMuted) }
    }
}
