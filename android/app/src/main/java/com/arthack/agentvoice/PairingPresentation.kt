package com.arthack.agentvoice

internal fun pairingFailureCopy(problem: PairingProblem): Pair<String, String> = when (problem) {
    PairingProblem.InvalidQr -> "Not an AgentVoice pairing code" to
        "Use Pair phone… in the AgentVoice desktop menu to show a new code."
    PairingProblem.ExpiredQr -> "This code has expired" to
        "Show a new code from Pair phone… on your desktop, then scan again."
    PairingProblem.InvalidEnrollment, PairingProblem.EnrollmentConsumed -> "Pairing wasn’t accepted" to
        "The code is no longer available. Your saved request is kept; ask the server owner to repair this phone’s pairing."
    PairingProblem.DeviceUnavailable -> "Device access is unavailable" to
        "Your saved request is kept. Ask the server owner to repair this phone’s pairing."
    PairingProblem.EnrollmentNotReady -> "Desktop isn’t ready yet" to
        "Keep the pairing window open on your desktop, then retry this request."
    PairingProblem.PairingLimited -> "Please try again shortly" to
        "The server has received too many pairing requests. Wait a moment, then retry."
    PairingProblem.PairingUnavailable -> "Pairing is unavailable" to
        "Check AgentVoice on your desktop, then retry the saved request."
    PairingProblem.Unreachable -> "Couldn’t reach your desktop" to
        "Check AgentVoice and Tailscale on both devices, then retry the saved request."
    PairingProblem.Protocol, PairingProblem.InvalidRequest -> "Pairing needs an update" to
        "Check that the app and desktop server are up to date. Your saved request is kept."
}
