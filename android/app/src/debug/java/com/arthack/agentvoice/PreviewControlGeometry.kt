package com.arthack.agentvoice

internal const val DEFAULT_PREVIEW_CONTROLS_HEIGHT_DP = 262
internal const val DEFAULT_PREVIEW_HOLD_SHARE_PERCENT = 116.0 / 262.0 * 100.0
internal const val PREVIEW_CONTROL_CONDUIT_DP = 16f

/** The share is measured against the whole deck, including its fixed capture conduit. */
internal data class PreviewControlGeometry(
    val controlsHeightDp: Int = DEFAULT_PREVIEW_CONTROLS_HEIGHT_DP,
    val holdSharePercent: Double = DEFAULT_PREVIEW_HOLD_SHARE_PERCENT,
) {
    init {
        require(controlsHeightDp in 240..480) { "Controls height must be between 240 and 480 dp" }
        require(holdSharePercent.isFinite() && holdSharePercent in 30.0..60.0) {
            "Hold share must be between 30 and 60 percent"
        }
    }

    val holdHeightDp: Float = (controlsHeightDp * holdSharePercent / 100.0).toFloat()
    val muteHeightDp: Float = controlsHeightDp - PREVIEW_CONTROL_CONDUIT_DP - holdHeightDp
}
