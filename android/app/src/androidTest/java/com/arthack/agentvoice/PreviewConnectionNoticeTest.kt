package com.arthack.agentvoice

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewConnectionNoticeTest {
    @get:Rule val compose = createComposeRule()

    @Test fun connectedHasNoNoticeOrReservedHeight() {
        compose.setContent {
            VoiceTheme {
                Column {
                    PreviewConnectionNotice("connected")
                    Box(Modifier.fillMaxWidth().height(1.dp).testTag("content-origin"))
                }
            }
        }
        compose.onNodeWithTag("preview-connection-notice").assertDoesNotExist()
        compose.onNodeWithText("Connected").assertDoesNotExist()
        val origin = compose.onNodeWithTag("content-origin").getUnclippedBoundsInRoot()
        assertEquals("Connected reserved vertical space: $origin", 0f, origin.top.value, .5f)
    }

    @Test fun problemNoticesPersistWithoutMovingContent() {
        compose.mainClock.autoAdvance = false
        var connection by mutableStateOf("connected")
        compose.setContent {
            VoiceTheme {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.align(Alignment.Center).size(160.dp).testTag("halo-placeholder"))
                    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(100.dp).testTag("controls-placeholder"))
                    PreviewConnectionNotice(connection, Modifier.align(Alignment.TopCenter))
                }
            }
        }
        val haloBefore = compose.onNodeWithTag("halo-placeholder").getUnclippedBoundsInRoot()
        val controlsBefore = compose.onNodeWithTag("controls-placeholder").getUnclippedBoundsInRoot()
        compose.runOnIdle { connection = "connecting" }
        val entryTops = mutableListOf<Float>()
        repeat(20) {
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            if (noticeExists()) entryTops += compose.onNodeWithTag("preview-connection-notice").getUnclippedBoundsInRoot().top.value
        }
        assertNotice("Connecting…")
        val restingTop = compose.onNodeWithTag("preview-connection-notice").getUnclippedBoundsInRoot().top.value
        assertTrue("Notice did not enter: $entryTops", entryTops.isNotEmpty())
        assertTrue("Notice overshot its resting position: $entryTops, resting=$restingTop",
            entryTops.all { it <= restingTop + .5f })
        assertTrue("Notice reversed direction during entry: $entryTops",
            entryTops.zipWithNext().all { (before, after) -> before <= after + .5f })
        compose.mainClock.advanceTimeBy(30_000)
        compose.waitForIdle()
        assertNotice("Connecting…")
        compose.runOnIdle { connection = "disconnected" }
        settleNotice()
        assertNotice("Disconnected")
        compose.mainClock.advanceTimeBy(30_000)
        compose.waitForIdle()
        assertNotice("Disconnected")
        assertEquals("Connection notice moved or resized the Halo region", haloBefore,
            compose.onNodeWithTag("halo-placeholder").getUnclippedBoundsInRoot())
        assertEquals("Connection notice moved or resized the controls", controlsBefore,
            compose.onNodeWithTag("controls-placeholder").getUnclippedBoundsInRoot())
    }

    @Test fun resolvingAndInterruptedExitKeepTheCorrectStatus() {
        compose.mainClock.autoAdvance = false
        var connection by mutableStateOf("connecting")
        compose.setContent { VoiceTheme { PreviewConnectionNotice(connection) } }
        settleNotice()
        assertNotice("Connecting…")
        compose.runOnIdle { connection = "connected" }
        repeat(3) {
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            // Disabled system animations may already have removed the outgoing notice.
            if (noticeExists()) compose.onNodeWithTag("preview-connection-notice").assertTextEquals("Connecting…")
            compose.onNodeWithText("Connected").assertDoesNotExist()
            compose.onNodeWithText("Disconnected").assertDoesNotExist()
        }
        compose.runOnIdle { connection = "disconnected" }
        settleNotice()
        assertNotice("Disconnected")
        compose.runOnIdle { connection = "connected" }
        settleNotice()
        compose.onNodeWithTag("preview-connection-notice").assertDoesNotExist()
        compose.onNodeWithText("Connected").assertDoesNotExist()
    }

    @Test fun landscapeNoticeFollowsPersonaSideAndHorizontalTuning() {
        var side by mutableStateOf("left")
        var offset by mutableStateOf(0)
        compose.setContent {
            VoiceTheme {
                Box(Modifier.requiredSize(800.dp, 360.dp)) {
                    PreviewStudioScreen(CallUi(), defaultLandscapeLayout().design,
                        defaultLandscapeLayout().placement, {}, {}, {}, {}, connection = "disconnected",
                        halo = PreviewHalo(variant = "contained"), personaSide = side,
                        horizontalOffsetDp = offset, mutedPresence = "off")
                }
            }
        }
        for (selectedSide in listOf("left", "right")) for (shift in listOf(-30, 0, 30)) {
            compose.runOnIdle { side = selectedSide; offset = shift }
            val persona = compose.onNodeWithTag("studio-persona-stage", useUnmergedTree = true).getUnclippedBoundsInRoot()
            val notice = compose.onNodeWithTag("preview-connection-notice").getUnclippedBoundsInRoot()
            assertEquals("$selectedSide/$shift notice center", (persona.left.value + persona.right.value) / 2f, (notice.left.value + notice.right.value) / 2f, 1f)
        }
    }

    private fun assertNotice(label: String) {
        compose.onNodeWithTag("preview-connection-notice").assertIsDisplayed().assertTextEquals(label)
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
            .assertHasNoClickAction()
    }

    private fun noticeExists() = compose.onAllNodesWithTag("preview-connection-notice").fetchSemanticsNodes().isNotEmpty()

    private fun settleNotice() {
        compose.mainClock.advanceTimeByFrame()
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(320)
        compose.waitForIdle()
    }
}
