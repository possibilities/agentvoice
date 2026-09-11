package com.arthack.agentvoice

import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class PreviewFourOrientationSessionTest {
    private val portrait = defaultPortraitLayout().copy(
        placement = defaultPortraitLayout().placement.copy(offsetY = (-11).dp),
        design = defaultPortraitLayout().design.copy(controlsHeightDp = 311),
    )
    private val landscape = defaultLandscapeLayout().copy(
        placement = defaultLandscapeLayout().placement.copy(offsetY = 22.dp),
        design = defaultLandscapeLayout().design.copy(controlsHeightDp = 322),
    )
    private val portraitReverse = portrait.copy(
        placement = portrait.placement.copy(offsetY = 33.dp),
        design = portrait.design.copy(controlsHeightDp = 333),
    )
    private val landscapeReverse = landscape.copy(
        placement = landscape.placement.copy(offsetY = 44.dp),
        design = landscape.design.copy(controlsHeightDp = 344),
    )

    private fun session(file: File) = PersonaPreviewSession(
        portrait.placement, file, portrait.design, portrait.halo, portrait.spirit, landscape,
        portrait.personaSide, portrait.horizontalOffsetDp, portrait.appearanceOverrides,
        PreviewSharedAppearance.from(portrait), initialPortraitReverse = portraitReverse,
        initialLandscapeReverse = landscapeReverse,
    )

    @Test fun rotationProjectsFourIndependentLayoutsAndSaveRestoresThem() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "four-orientation-${UUID.randomUUID()}.json")
        try {
            val session = withContext(Dispatchers.Main) { session(file) }
            val expected = mapOf(previewPortrait to portrait, previewLandscape to landscape,
                previewPortraitReverse to portraitReverse, previewLandscapeReverse to landscapeReverse)
            for (orientation in listOf(previewPortrait, previewLandscape, previewPortraitReverse, previewLandscapeReverse)) {
                withContext(Dispatchers.Main) { session.state = session.state.rotate(orientation) }
                val state = withContext(Dispatchers.Main) { session.state }
                assertEquals(expected.getValue(orientation), state.activeLayout())
                assertEquals(expected.getValue(facingPreviewOrientation(orientation)), state.otherLayout)
                assertEquals(oppositePreviewOrientations(orientation), state.remainingLayouts.keys)
                val remaining = state.json().getJSONObject("remainingLayouts")
                val expectedKeys = if (orientation in setOf(previewPortrait, previewLandscape))
                    setOf("portraitReverse", "landscapeReverse") else setOf("portrait", "landscape")
                assertEquals(expectedKeys, remaining.fields())
            }
            val before = withContext(Dispatchers.Main) { session.state }
            val profile = session.command(JSONObject().put("id", 1).put("method", "save")
                .put("revision", before.revision).put("orientation", before.orientation)
                .put("orientationEpoch", before.orientationEpoch)).getString("profile")
            assertEquals(22, JSONObject(profile).getInt("version"))
            val decoded = decodePreviewProfileLayouts(profile)
            assertEquals(expected, decoded.asMap())
            val saved = withContext(Dispatchers.Main) { session.state }
            assertEquals(saved, restorePersonaPreview(saved.json(), saved.saved))
            assertTrue(saved.json().toString().toByteArray().size < 65536)
        } finally { file.delete() }
    }

    @Test fun sharedSpacingUpdatesEverySlotWhileGeometryRemainsIndependent() = runBlocking {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "four-spacing-${UUID.randomUUID()}.json")
        try {
            val session = withContext(Dispatchers.Main) { session(file) }
            withContext(Dispatchers.Main) {
                val requested = session.state.activeLayout().copy(design = session.state.design.copy(
                    spacing = session.state.design.spacing.copy(paddingDp = 23)))
                session.state = session.state.applyAppearance(requested)
            }
            val state = withContext(Dispatchers.Main) { session.state }
            assertTrue(state.layouts().values.all { it.design.spacing.paddingDp == 23 })
            assertEquals(setOf(-11, 22, 33, 44), state.layouts().values.map { it.placement.offsetY.value.toInt() }.toSet())
        } finally { file.delete() }
    }

    @Test fun versionTwentyProfileClonesEachAxisWithoutRewritingSavedBytes() {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "four-legacy-${UUID.randomUUID()}.json")
        try {
            val current = JSONObject(encodePersonaTuning(portrait.placement, portrait.design, portrait.halo,
                portrait.spirit, landscape, portrait.personaSide, portrait.horizontalOffsetDp,
                portrait.appearanceOverrides, PreviewSharedAppearance.from(portrait)))
            val legacy = current.put("version", 20).apply {
                remove("connectionStyle")
                remove("portraitReverse")
                remove("landscapeReverse")
            }.toString(2)
            file.writeText(legacy)
            val decoded = decodePreviewProfileLayouts(file.readText())
            assertEquals(decoded.portrait, decoded.portraitReverse)
            assertEquals(decoded.landscape, decoded.landscapeReverse)
            assertEquals(legacy, file.readText())
        } finally { file.delete() }
    }
}
