import AgentVoiceAppCore
import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

require(
    parseLaunchctlState("path = /tmp/job\n\tstate = running\npid = 42\n") == .running,
    "running launchd state was not recognized"
)
require(
    parseLaunchctlState("\tstate = waiting\n") == .loaded("waiting"),
    "non-running launchd state was not preserved"
)
require(
    parseLaunchctlState("stateful = running\n") == .unavailable,
    "an unrelated launchd key was treated as state"
)
require(parseLaunchctlState("") == .unavailable, "empty launchd output was accepted")

require(
    LoginItemPresentation(state: .disabled)
        == LoginItemPresentation(
            title: "Run AgentVoice at login",
            checked: false,
            enabled: true,
            action: .register
        ),
    "disabled login-item presentation changed"
)
require(
    LoginItemPresentation(state: .enabled)
        == LoginItemPresentation(
            title: "Run AgentVoice at login",
            checked: true,
            enabled: true,
            action: .unregister
        ),
    "enabled login-item presentation changed"
)
require(
    LoginItemPresentation(state: .approvalRequired)
        == LoginItemPresentation(
            title: "Open Login Item Settings…",
            checked: false,
            enabled: true,
            action: .openSettings
        ),
    "approval-required login-item presentation changed"
)

let firstLaunch = LoginItemDefaultPlan(state: .disabled, defaultWasRecorded: false)
let optedOut = LoginItemDefaultPlan(state: .disabled, defaultWasRecorded: true)
let alreadyEnabled = LoginItemDefaultPlan(state: .enabled, defaultWasRecorded: false)
let unavailable = LoginItemDefaultPlan(state: .unavailable, defaultWasRecorded: false)

require(
    firstLaunch.recordDefault && firstLaunch.action == .register,
    "first launch no longer defaults the login item on"
)
require(
    !optedOut.recordDefault && optedOut.action == .none,
    "an explicit login-item choice would be overwritten"
)
require(
    alreadyEnabled.recordDefault && alreadyEnabled.action == .none,
    "an existing enabled login item would be registered twice"
)
require(
    !unavailable.recordDefault && unavailable.action == .none,
    "an unavailable login API incorrectly consumed the first-launch default"
)

print("AgentVoice macOS menu checks passed.")
