package com.arthack.agentvoice

internal const val DEFAULT_PREVIEW_CONTROLS_HEIGHT_DP = 262
internal const val DEFAULT_PREVIEW_HOLD_SHARE_PERCENT = 116.0 / 262.0 * 100.0
internal const val PREVIEW_CONTROL_CONDUIT_DP = 16f

/** The share is measured against the whole deck, including the baseline capture conduit. Extra join space never steals face height. */
internal data class PreviewControlGeometry(
    val controlsHeightDp: Int = DEFAULT_PREVIEW_CONTROLS_HEIGHT_DP,
    val holdSharePercent: Double = DEFAULT_PREVIEW_HOLD_SHARE_PERCENT,
    val pushGapDp: Int = 16,
    val showPushToTalk: Boolean = true,
) {
    init {
        require(pushGapDp in 0..48)
        require(controlsHeightDp in 240..480) { "Controls height must be between 240 and 480 dp" }
        require(holdSharePercent.isFinite() && holdSharePercent in 30.0..60.0) {
            "Hold share must be between 30 and 60 percent"
        }
    }

    val extentHeightDp: Float = if (showPushToTalk) controlsHeightDp + pushGapDp - PREVIEW_CONTROL_CONDUIT_DP else controlsHeightDp.toFloat()
    val holdHeightDp: Float = if (showPushToTalk) (controlsHeightDp * holdSharePercent / 100.0).toFloat() else 0f
    val muteHeightDp: Float = if (showPushToTalk) controlsHeightDp - PREVIEW_CONTROL_CONDUIT_DP - holdHeightDp else controlsHeightDp.toFloat()
}


internal data class PreviewControlFit(val extent: Float, val mute: Float, val gap: Float, val hold: Float)

/** Preserve face proportions if a short visible viewport cannot accommodate the requested deck. */
internal fun PreviewControlGeometry.fitWithin(availableHeightDp: Float?): PreviewControlFit {
    if (!showPushToTalk) {
        require(availableHeightDp == null || availableHeightDp.isFinite() && availableHeightDp > 0f)
        val height = minOf(extentHeightDp, availableHeightDp ?: extentHeightDp)
        return PreviewControlFit(height, height, 0f, 0f)
    }
    if (availableHeightDp == null || availableHeightDp >= extentHeightDp)
        return PreviewControlFit(extentHeightDp, muteHeightDp, pushGapDp.toFloat(), holdHeightDp)
    require(availableHeightDp.isFinite() && availableHeightDp > 0f)
    val gap = minOf(pushGapDp.toFloat(), availableHeightDp / 3f)
    val ratio = (availableHeightDp - gap) / (muteHeightDp + holdHeightDp)
    return PreviewControlFit(availableHeightDp, muteHeightDp * ratio, gap, holdHeightDp * ratio)
}
