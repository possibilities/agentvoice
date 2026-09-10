package com.arthack.agentvoice

import kotlin.math.PI
import kotlin.math.sin

internal enum class PreviewCenterChannelKind { Human, Agent }

internal data class PreviewCenterChannel(val kind: PreviewCenterChannelKind, val open: Boolean) {
    val label: String get() = if (open) "live" else "muted"
}

internal data class PreviewCenterIndicatorModel(
    val style: String,
    val words: List<String>,
    val channels: List<PreviewCenterChannel>,
)

private val previewCenterStyles = setOf("words", "channels", "labeled", "contacts")

internal fun previewCenterIndicatorEligible(
    ui: CallUi,
    style: String,
    scope: String,
    foreground: Boolean,
): Boolean {
    if (!foreground || !ui.connected || ui.controlsPending) return false
    val bothMuted = !ui.micOpen && !ui.speakerOpen
    if (style == "tide") return bothMuted
    if (style !in previewCenterStyles) return false
    return when (scope) {
        "both-muted" -> bothMuted
        "any-muted" -> !ui.micOpen || !ui.speakerOpen
        "always" -> true
        else -> false
    }
}

/** Preferences and animation state cannot establish whether a channel is actually open. */
internal fun previewCenterIndicatorModel(
    ui: CallUi,
    style: String,
    scope: String,
    foreground: Boolean,
): PreviewCenterIndicatorModel? {
    if (style !in previewCenterStyles || !previewCenterIndicatorEligible(ui, style, scope, foreground)) return null
    val words = when {
        ui.micOpen && ui.speakerOpen -> listOf("live")
        !ui.micOpen && !ui.speakerOpen -> listOf("both", "muted")
        !ui.micOpen -> listOf("human", "muted")
        else -> listOf("agent", "muted")
    }
    return PreviewCenterIndicatorModel(style, words, listOf(
        PreviewCenterChannel(PreviewCenterChannelKind.Human, ui.micOpen),
        PreviewCenterChannel(PreviewCenterChannelKind.Agent, ui.speakerOpen),
    ))
}

/** The same fitted envelope covers every letter, icon, and contact, including their ripple phase. */
internal fun previewCenterIndicatorFrame(
    phase: Float,
    motionAllowed: Boolean,
    fit: PreviewMutedPresenceFit,
    tuning: PreviewMutedTuning,
    atomCount: Int,
): PreviewMutedPresenceFrame {
    val frame = previewMutedPresenceFrame(phase, motionAllowed, fit, tuning)
    val offsets = if (motionAllowed && phase.isFinite() && tuning.motion == "ripple" && fit.rippleYPx > 0f) {
        val angle = (phase.toDouble() % 1.0) * 2.0 * PI
        List(atomCount.coerceAtLeast(0)) { fit.rippleYPx * sin(angle - it * .8).toFloat() }
    } else emptyList()
    return frame.copy(glyphOffsets = offsets)
}
