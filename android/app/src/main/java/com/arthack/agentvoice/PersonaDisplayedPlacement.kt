package com.arthack.agentvoice

import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Read from a draw phase to follow the native wrapper without recomposing it per frame. */
@Stable
internal class PersonaDisplayedPlacement {
    private var source by mutableStateOf<State<Float>?>(null)

    val scale: Float? get() = source?.value

    fun bind(appliedScale: State<Float>) { source = appliedScale }

    fun release(appliedScale: State<Float>) {
        // An outgoing view cannot clear a successor's placement observation.
        if (source === appliedScale) source = null
    }
}
