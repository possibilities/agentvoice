package com.arthack.agentvoice

import androidx.compose.runtime.mutableStateOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PersonaDisplayedPlacementTest {
    @Test fun startsWithoutADisplayedScale() {
        assertNull(PersonaDisplayedPlacement().scale)
    }

    @Test fun bindingTracksLiveScaleUpdates() {
        val scale = mutableStateOf(1f)
        val placement = PersonaDisplayedPlacement()

        placement.bind(scale)
        assertEquals(1f, placement.scale)

        scale.value = 1.25f
        assertEquals(1.25f, placement.scale)
    }

    @Test fun releasingTheBoundScaleClearsTheDisplayedScale() {
        val scale = mutableStateOf(.8f)
        val placement = PersonaDisplayedPlacement()

        placement.bind(scale)
        placement.release(scale)

        assertNull(placement.scale)
    }

    @Test fun anOldReleaseCannotClearANewerBinding() {
        val oldScale = mutableStateOf(.9f)
        val newScale = mutableStateOf(1.1f)
        val placement = PersonaDisplayedPlacement()

        placement.bind(oldScale)
        placement.bind(newScale)
        placement.release(oldScale)

        assertEquals(1.1f, placement.scale)
        newScale.value = 1.2f
        assertEquals(1.2f, placement.scale)
    }
}
