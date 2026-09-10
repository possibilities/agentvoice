package com.arthack.agentvoice

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt

/**
 * Pure decoration over the user's palette. The parent owns the clock and energy envelope.
 * [phase] is one raw 0..1 cycle; [energy] and [amount] are normalized amounts.
 * Effective gates, including a held microphone, take precedence over mute preferences.
 */
internal fun personaSpiritColors(
    base: CompactHaloColors,
    ui: CallUi,
    phase: Float,
    energy: Float = 0f,
    amount: Float = 1f,
    motionAllowed: Boolean = true,
): CompactHaloColors {
    val strength = spiritUnit(amount)
    if (strength == 0f || !ui.connected) return base

    val moving = motionAllowed && !ui.controlsPending
    val wave = if (moving) ((1.0 - cos(spiritUnit(phase) * 2.0 * PI)) * .5).toFloat() else 0f
    val activity = if (moving) spiritUnit(energy) else 0f
    val state = personaState(ui)
    fun channel(color: Int, open: Boolean, owner: PersonaState): Int {
        if (!open) return spiritMix(color, spiritBlack, .08f * strength)
        val sheen = .03f * wave + if (state == owner) .01f * activity else 0f
        return spiritMix(color, spiritWhite, sheen * strength)
    }

    val idleGround = when {
        ui.micOpen && !ui.speakerOpen -> spiritMix(base.idle, base.listening, .08f * strength)
        ui.speakerOpen && !ui.micOpen -> spiritMix(base.idle, base.speaking, .08f * strength)
        !ui.micOpen && !ui.speakerOpen -> spiritMix(base.idle, spiritBlack, .08f * strength)
        else -> base.idle
    }
    val idle = if (ui.micOpen || ui.speakerOpen) spiritMix(idleGround, spiritWhite, .02f * wave * strength) else idleGround
    return CompactHaloColors(
        speaking = channel(base.speaking, ui.speakerOpen, PersonaState.Speaking),
        listening = channel(base.listening, ui.micOpen, PersonaState.Listening),
        idle = idle,
    )
}

/** The parent supplies linear progress and snaps on disable, reduced motion or backgrounding. */
internal fun blendPersonaSpiritColors(
    from: CompactHaloColors,
    to: CompactHaloColors,
    progress: Float,
): CompactHaloColors {
    val unit = spiritUnit(progress)
    if (unit == 0f) return from
    if (unit == 1f) return to
    if (from == to) return from
    val eased = unit * unit * (3f - 2f * unit)
    return CompactHaloColors(
        speaking = spiritMix(from.speaking, to.speaking, eased),
        listening = spiritMix(from.listening, to.listening, eased),
        idle = spiritMix(from.idle, to.idle, eased),
    )
}

private const val spiritBlack = 0xFF000000.toInt()
private const val spiritWhite = 0xFFFFFFFF.toInt()

private fun spiritUnit(value: Float): Float = if (value.isFinite()) value.coerceIn(0f, 1f) else 0f

private fun spiritMix(from: Int, to: Int, amount: Float): Int {
    if (amount == 0f || from == to) return from
    if (amount == 1f) return to
    fun component(shift: Int): Int {
        val start = (from ushr shift) and 255
        val end = (to ushr shift) and 255
        return (start + (end - start) * amount).roundToInt()
    }
    return spiritBlack or (component(16) shl 16) or (component(8) shl 8) or component(0)
}
