package com.arthack.agentvoice

import android.content.res.Configuration
import android.view.Surface
import org.junit.Assert.assertEquals
import org.junit.Test

class PreviewOrientationSelectionTest {
    @Test fun naturalPortraitDisplayRotationsSelectAllFourSlots() {
        assertEquals(previewPortrait, previewOrientation(Configuration.ORIENTATION_PORTRAIT, Surface.ROTATION_0))
        assertEquals(previewLandscape, previewOrientation(Configuration.ORIENTATION_LANDSCAPE, Surface.ROTATION_90))
        assertEquals(previewPortraitReverse, previewOrientation(Configuration.ORIENTATION_PORTRAIT, Surface.ROTATION_180))
        assertEquals(previewLandscapeReverse, previewOrientation(Configuration.ORIENTATION_LANDSCAPE, Surface.ROTATION_270))
    }

    @Test fun facingPairsKeepTheSamePhysicalScreenEdge() {
        assertEquals(previewLandscape, facingPreviewOrientation(previewPortrait))
        assertEquals(previewPortrait, facingPreviewOrientation(previewLandscape))
        assertEquals(previewLandscapeReverse, facingPreviewOrientation(previewPortraitReverse))
        assertEquals(previewPortraitReverse, facingPreviewOrientation(previewLandscapeReverse))
    }
}
