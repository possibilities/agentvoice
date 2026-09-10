package com.arthack.agentvoice

/** Local restrictions may close a server gate, never open one on their own. */
internal class AudioGate {
    var state = VoiceState(); private set
    var connected = false
    var holding = false; private set
    private var holdAcknowledged = false
    private var micIntent: Boolean? = null
    private var speakerIntent: Boolean? = null
    private var micAcknowledged = false
    private var speakerAcknowledged = false
    val controlsPending get() = micIntent != null || speakerIntent != null
    val canHold get() = connected && state.available && state.phase == "live" &&
        state.mic.muted && !controlsPending
    val micOpen get() = connected && state.available && !state.mic.effectiveMuted &&
        state.phase !in setOf("failed", "stopped") &&
        micIntent != true && (!state.mic.muted || (holding && holdAcknowledged))
    val speakerOpen get() = connected && state.available && !state.speaker.effectiveMuted &&
        state.phase !in setOf("failed", "stopped") &&
        speakerIntent != true

    fun state(value: VoiceState) {
        state = value
        if (!value.mic.muted) release()
        reconcile()
    }
    fun intent(target: String, muted: Boolean) {
        release()
        if (target == "mic") { micIntent = muted; micAcknowledged = false }
        else { speakerIntent = muted; speakerAcknowledged = false }
    }
    fun acknowledgeMute(target: String) {
        // Clear only after both the request and matching authoritative state arrive.
        if (target == "mic") micAcknowledged = true else speakerAcknowledged = true
        reconcile()
    }
    private fun reconcile() {
        if (micAcknowledged && state.mic.muted == micIntent) micIntent = null
        if (speakerAcknowledged && state.speaker.muted == speakerIntent) speakerIntent = null
    }
    fun hold(): Boolean {
        if (!canHold || holding) return false
        holding = true
        holdAcknowledged = false
        return true
    }
    fun acknowledgeHold() { if (holding) holdAcknowledged = true }
    fun release(): Boolean {
        val wasHolding = holding
        holding = false
        holdAcknowledged = false
        return wasHolding
    }
    fun stop() {
        connected = false
        release()
        micIntent = null
        speakerIntent = null
        micAcknowledged = false
        speakerAcknowledged = false
        state = VoiceState()
    }
}
