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
            title: "Show in Menu Bar at Login",
            checked: false,
            enabled: true,
            action: .register
        ),
    "disabled login-item presentation changed"
)
require(
    LoginItemPresentation(state: .enabled)
        == LoginItemPresentation(
            title: "Show in Menu Bar at Login",
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

print("AgentVoice macOS menu checks passed.")
