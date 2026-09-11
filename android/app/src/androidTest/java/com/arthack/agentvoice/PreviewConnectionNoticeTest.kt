package com.arthack.agentvoice

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewConnectionNoticeTest {
    @get:Rule val compose = createComposeRule()

    @Test fun connectedHasNoNoticeOrReservedHeight() {
        compose.setContent { VoiceTheme { Column {
            PreviewConnectionNotice("connected")
            Box(Modifier.fillMaxWidth().height(1.dp).testTag("content-origin"))
        } } }
        compose.onNodeWithTag("preview-connection-notice").assertDoesNotExist()
        assertEquals(0f, compose.onNodeWithTag("content-origin").getUnclippedBoundsInRoot().top.value, .5f)
    }

    @Test fun allStylesRetainTruthAndOnlyExplicitActionsConnect() {
        var connection by mutableStateOf("disconnected")
        var style by mutableStateOf("relay")
        var connects = 0
        compose.setContent { VoiceTheme {
            PreviewConnectionNotice(connection, style = style, innerRadius = 140.dp,
                onConnect = if (connection in setOf("disconnected", "failed")) ({ connects++ }) else null)
        } }
        for (selected in listOf("relay", "beacon", "datum")) {
            compose.runOnIdle { style = selected; connection = "disconnected" }
            compose.onNodeWithTag("preview-connection-notice")
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
            compose.onNodeWithTag("connection-primary-action").assertIsDisplayed().performClick()
            compose.runOnIdle { connection = "connecting" }
            compose.onNodeWithTag("connection-primary-action").assertDoesNotExist()
            compose.onNodeWithText("Connecting").assertExists()
            compose.runOnIdle { connection = "connected" }
            compose.onNodeWithTag("preview-connection-notice").assertDoesNotExist()
        }
        compose.runOnIdle { assertEquals(3, connects) }
    }

    @Test fun failedDetailsAreCompleteAndCancelRemainsExplicit() {
        var ends = 0
        val detail = "The server rejected this attempt. Your device access was kept."
        compose.setContent { VoiceTheme {
            PreviewConnectionNotice("failed", innerRadius = 140.dp, detail = detail, onCancel = { ends++ })
        } }
        compose.onNodeWithTag("connection-details").performClick()
        compose.onNodeWithTag("connection-detail-text").assertTextEquals(detail)
        compose.runOnIdle { assertEquals(0, ends) }
        compose.onNodeWithTag("connection-dialog-action").performClick()
        compose.runOnIdle { assertEquals(1, ends) }
    }

    @Test fun smallApertureAndLargeFontsKeepOneUsableActionWithFullDetails() {
        var connects = 0
        compose.setContent { VoiceTheme {
            CompositionLocalProvider(LocalDensity provides Density(1f, 2f)) {
                PreviewConnectionNotice("failed", innerRadius = 45.dp, detail = "An actionable server error",
                    onConnect = { connects++ })
            }
        } }
        compose.onNodeWithTag("connection-compact").assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithText("An actionable server error").assertExists()
        compose.onNodeWithTag("connection-dialog-action").performClick()
        compose.runOnIdle { assertEquals(1, connects) }
    }

    @Test fun noticeFollowsPersonaInBothAxesWithoutMovingTheDeck() {
        var portrait by mutableStateOf(true)
        var side by mutableStateOf("left")
        var offset by mutableStateOf(0)
        var connection by mutableStateOf("connected")
        compose.setContent { VoiceTheme {
            Box(Modifier.requiredSize(if (portrait) 360.dp else 800.dp, if (portrait) 800.dp else 360.dp)) {
                PreviewStudioScreen(CallUi(), defaultLandscapeLayout().design,
                    defaultLandscapeLayout().placement.copy(offsetY = offset.dp), {}, {}, {}, {}, connection = connection,
                    halo = PreviewHalo(variant = "contained"), personaSide = side,
                    horizontalOffsetDp = offset, mutedPresence = "off")
            }
        } }
        for (axis in listOf(true, false)) for (selectedSide in listOf("left", "right")) for (shift in listOf(-20, 20)) {
            compose.runOnIdle { portrait = axis; side = selectedSide; offset = shift; connection = "connected" }
            val deck = compose.onNodeWithTag("preview-controls").getUnclippedBoundsInRoot()
            val persona = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
            compose.runOnIdle { connection = "disconnected" }
            val notice = compose.onNodeWithTag("preview-connection-notice").getUnclippedBoundsInRoot()
            assertEquals((persona.left.value + persona.right.value) / 2f, (notice.left.value + notice.right.value) / 2f, 1f)
            assertEquals((persona.top.value + persona.bottom.value) / 2f + if (axis) shift else 0,
                (notice.top.value + notice.bottom.value) / 2f, 1f)
            assertEquals(deck, compose.onNodeWithTag("preview-controls").getUnclippedBoundsInRoot())
        }
    }
}
