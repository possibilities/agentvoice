package com.arthack.agentvoice

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PreviewControlTypographyTest {
    @get:Rule val compose = createComposeRule()

    @Test fun everyCaptionFitsTheRockerAtExtremeSplitsAndLargerSystemText() {
        var geometry by mutableStateOf(PreviewControlGeometry())
        var scale by mutableStateOf(1f)
        var name by mutableStateOf("HUMAN")
        var status by mutableStateOf("on")
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, scale)) {
                VoiceTheme {
                    Box(Modifier.fillMaxSize()) {
                        // The real face is tested directly because its owner clears duplicate spoken labels.
                        RockerMuteFace(name, name == "AGENT", status in listOf("off", "live"),
                            if (name == "AGENT") VoiceInk.agent else VoiceInk.you, status, false,
                            (geometry.muteHeightDp / 130f).coerceIn(.6f, 1.6f),
                            Modifier.width(137.dp).height(geometry.muteHeightDp.dp).testTag("rocker-face"), null, false)
                    }
                }
            }
        }
        for (height in listOf(240, 480)) for (share in listOf(30.0, 60.0)) {
            for (fontScale in listOf(1f, 1.5f)) for (channel in listOf("HUMAN", "AGENT")) {
                var previousName: DpRect? = null
                var previousStatus: DpRect? = null
                for (state in listOf("on", "off", "live", "wait")) {
                    compose.runOnIdle {
                        geometry = PreviewControlGeometry(height, share)
                        scale = fontScale
                        name = channel
                        status = state
                    }
                    val context = "$height dp/$share%, font $fontScale, $channel $state"
                    val face = compose.onNodeWithTag("rocker-face").getUnclippedBoundsInRoot()
                    val channelNode = compose.onNodeWithTag("rocker-channel-caption")
                    val stateNode = compose.onNodeWithTag("rocker-state-caption")
                    channelNode.assertTextEquals(channel).assertIsDisplayed()
                    stateNode.assertTextEquals(state).assertIsDisplayed()
                    val channelBounds = channelNode.getUnclippedBoundsInRoot()
                    val stateBounds = stateNode.getUnclippedBoundsInRoot()
                    assertContained(face, channelBounds, context)
                    assertContained(face, stateBounds, context)
                    assertTrue(context, channelBounds.right <= stateBounds.left)
                    if (previousName != null) assertEquals("$context moved the channel", previousName, channelBounds)
                    if (previousStatus != null) assertEquals("$context moved the state", previousStatus, stateBounds)
                    previousName = channelBounds
                    previousStatus = stateBounds
                    for (node in listOf(channelNode, stateNode)) {
                        val results = mutableListOf<TextLayoutResult>()
                        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(results)) }
                        val result = results.single()
                        assertFalse("$context overflowed ${result.layoutInput.text}", result.hasVisualOverflow)
                        assertFalse(context, result.isLineEllipsized(0))
                        assertEquals(context, fontScale, result.layoutInput.density.fontScale, .001f)
                    }
                    val statusLayout = mutableListOf<TextLayoutResult>()
                    stateNode.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(statusLayout) }
                    assertTrue(context, statusLayout.single().layoutInput.style.fontSize.value >= 14f)
                    assertEquals(FontWeight.SemiBold, statusLayout.single().layoutInput.style.fontWeight)
                    val glyph = compose.onNodeWithTag("rocker-channel-glyph").getUnclippedBoundsInRoot()
                    val expectedGlyph = (46f * (geometry.muteHeightDp / 130f).coerceIn(.6f, 1.6f)).coerceIn(30f, 72f)
                    assertEquals(context, expectedGlyph, (glyph.right - glyph.left).value, .5f)
                    assertEquals(context, expectedGlyph, (glyph.bottom - glyph.top).value, .5f)
                    assertTrue("$context overlaps its glyph", channelBounds.top >= glyph.bottom && stateBounds.top >= glyph.bottom)
                }
            }
        }
    }

    @Test fun newlyAllowedShortAndNarrowFacesKeepCaptionsInside() {
        var width by mutableStateOf(48)
        var height by mutableStateOf(140)
        var label by mutableStateOf("HUMAN")
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.5f)) {
                VoiceTheme { RockerMuteFace(label, label == "AGENT", true, VoiceInk.muted, "wait", false,
                    (height / 130f).coerceIn(.6f, 1.6f), Modifier.width(width.dp).height(height.dp).testTag("compact-face"), null, false) }
            }
        }
        for ((w, h) in listOf(48 to 140, 73 to 140, 160 to 48)) for (name in listOf("HUMAN", "AGENT")) {
            compose.runOnIdle { width = w; height = h; label = name }
            val face = compose.onNodeWithTag("compact-face").getUnclippedBoundsInRoot()
            for (tag in listOf("rocker-channel-caption", "rocker-state-caption")) {
                val node = compose.onNodeWithTag(tag)
                assertContained(face, node.getUnclippedBoundsInRoot(), "$w/$h $name")
                val result = mutableListOf<TextLayoutResult>()
                node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(result)) }
                assertFalse("$w/$h $name $tag ${result.single().size} ${result.single().layoutInput.style.fontSize} width=${result.single().didOverflowWidth} height=${result.single().didOverflowHeight} paragraph=${result.single().multiParagraph.width}/${result.single().multiParagraph.height}", result.single().hasVisualOverflow)
            }
        }
    }

    @Test fun narrowAndShallowPushFacesFitAtLargeText() {
        var width by mutableStateOf(48)
        var height by mutableStateOf(300)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.5f)) {
                VoiceTheme { RockerHoldFace(CallUi(connected = true, micMuted = true, canHold = true),
                    VoiceInk.you, VoiceInk.surface, Modifier.size(width.dp, height.dp).testTag("push-face"), null, false) }
            }
        }
        for ((w, h) in listOf(48 to 300, 300 to 48)) {
            compose.runOnIdle { width = w; height = h }
            val face = compose.onNodeWithTag("push-face").getUnclippedBoundsInRoot()
            for (label in listOf("Push", "to talk")) {
                val node = compose.onNodeWithText(label)
                assertContained(face, node.getUnclippedBoundsInRoot(), "$w/$h $label")
                val results = mutableListOf<TextLayoutResult>()
                node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
                assertFalse("$w/$h $label ${results.single().size} paragraph=${results.single().multiParagraph.width}/${results.single().multiParagraph.height}", results.single().hasVisualOverflow)
            }
        }
    }

    private fun assertContained(outer: DpRect, inner: DpRect, context: String) {
        assertTrue(context, inner.left >= outer.left && inner.top >= outer.top)
        assertTrue(context, inner.right <= outer.right && inner.bottom <= outer.bottom)
    }
}
