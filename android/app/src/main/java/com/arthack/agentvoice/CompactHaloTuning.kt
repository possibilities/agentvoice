package com.arthack.agentvoice

import androidx.compose.ui.graphics.toArgb

internal data class CompactHaloTuning(
    val ringSpreadPercent: Int = 35,
    val listeningPulsePercent: Int = 25,
    val speakingMotionPercent: Int = 25,
    val idleBreathingPercent: Int = 25,
    val thinkingWingspan: Int = 2,
) {
    init {
        require(thinkingWingspan in 1..10) { "Thinking wingspan must be between 1 and 10." }
        require(listOf(ringSpreadPercent, listeningPulsePercent, speakingMotionPercent, idleBreathingPercent).all { it in 0..100 }) {
            "Contained Halo motion must be between 0 and 100 percent."
        }
    }
}

internal fun thinkingDashScale(wingspan: Int): Float {
    require(wingspan in 1..10)
    // Keep the prior compact geometry exactly at 2 and the authored reach at 10.
    return when (wingspan) {
        1 -> 1.025f
        2 -> 1.05f
        10 -> 1.28f
        else -> 1.05f + (wingspan - 2) * (.23f / 8f)
    }
}

internal data class CompactHaloColors(
    val speaking: Int = VoiceInk.agent.toArgb(),
    val listening: Int = VoiceInk.you.toArgb(),
    val idle: Int = VoiceInk.text.toArgb(),
    val asleep: Int = VoiceInk.muted.toArgb(),
) {
    init {
        require(listOf(speaking, listening, idle, asleep).all { (it ushr 24) == 255 }) {
            "Contained Halo colors must be opaque."
        }
    }

    fun forState(state: PersonaState): Int = when (state) {
        PersonaState.Speaking -> speaking
        PersonaState.Listening -> listening
        PersonaState.Idle, PersonaState.Thinking -> idle
        PersonaState.Asleep -> asleep
    }
}
