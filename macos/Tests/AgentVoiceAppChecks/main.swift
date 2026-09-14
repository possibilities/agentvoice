import AgentVoiceAppCore
import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

require(WaitingServerState.running.menuTitle == "AgentVoice is running", "running menu copy changed")
require(AgentVoiceMenuCopy.pairPhone == "Pair phone…", "pair-phone menu copy changed")
require(AgentVoiceMenuCopy.runAtLogin == "Show menu at login", "login menu copy changed")
require(AgentVoiceMenuCopy.quit == "Quit AgentVoice menu", "quit menu copy changed")
require(PairPhoneCopy.title == "Pair your phone", "pair-phone title changed")
require(
    PairPhoneCopy.instruction == "Open AgentVoice on your phone and scan this code.",
    "pair-phone instruction changed"
)
require(
    PairPhoneCopy.durableNote.contains("stays paired"),
    "durable pairing copy no longer distinguishes code expiry from pairing lifetime"
)
require(WaitingServerState.unloaded.menuTitle == "AgentVoice is unloaded", "unloaded copy changed")
require(WaitingServerState.unavailable.actions.isEmpty, "unknown status permits mutations")
require(WaitingServerState.unloaded.actions == [.load], "unloaded actions changed")
require(WaitingServerState.loaded.actions == [.restart, .unload], "loaded actions changed")
require(!ServerAction.load.accepts(.unloaded), "load accepted an unloaded result")
require(!ServerAction.restart.accepts(.unavailable), "restart accepted an unknown result")
require(ServerAction.unload.accepts(.unloaded), "unload rejected confirmed state")
require(!ServerAction.unload.accepts(.notInstalled), "unload treated missing installation as success")
require(ServerAction.restart.confirmation?.contains("background work") == true, "restart hides retained-work consequence")
require(ServerAction.unload.confirmation?.contains("sign in") == true, "unload hides login lifetime")
for state in [WaitingServerState.running, .loaded, .unloaded, .notInstalled] {
    let data = Data("{\"version\":1,\"state\":\"\(state.rawValue)\"}".utf8)
    require((try? decodeServiceSnapshot(data)) == state, "service status did not decode")
}
for data in ["{}", "{\"version\":2,\"state\":\"running\"}", "{\"version\":1,\"state\":\"checking\"}", "not JSON"] {
    require((try? decodeServiceSnapshot(Data(data.utf8))) == nil, "invalid service status was accepted")
}
let command = ServiceCommand(executable: "/fixed/runtime", entrypoint: "/checkout with spaces/main.ts")
require(command.arguments(action: .unload) == ["/checkout with spaces/main.ts", "service", "unload", "--json"], "service argv lost its fixed scope")

require(
    LoginItemPresentation(state: .disabled)
        == LoginItemPresentation(
            title: "Show menu at login",
            checked: false,
            enabled: true,
            action: .register
        ),
    "disabled login-item presentation changed"
)
require(
    LoginItemPresentation(state: .enabled)
        == LoginItemPresentation(
            title: "Show menu at login",
            checked: true,
            enabled: true,
            action: .unregister
        ),
    "enabled login-item presentation changed"
)
require(
    LoginItemPresentation(state: .approvalRequired)
        == LoginItemPresentation(
            title: "Open login item settings…",
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

let fixtureRoot = FileManager.default.temporaryDirectory.appendingPathComponent("AgentVoice service checks \(UUID().uuidString)")
try FileManager.default.createDirectory(at: fixtureRoot, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: fixtureRoot) }
let fixture = fixtureRoot.appendingPathComponent("fixed command.sh")
try """
case "$1:$2:$3" in
  service:status:--json|service:load:--json|service:restart:--json)
    printf '%s\\n' '{"version":1,"state":"running"}' ;;
  service:unload:--json)
    printf '%s\\n' '{"version":1,"state":"unloaded"}' ;;
  *) exit 42 ;;
esac
""".write(to: fixture, atomically: true, encoding: .utf8)
let fixtureCommand = ServiceCommand(executable: "/bin/sh", entrypoint: fixture.path)
let running = try await fixtureCommand.run()
let unloaded = try await fixtureCommand.run(action: .unload)
require(running == .running && unloaded == .unloaded, "fixed subprocess invocation failed")
try "printf '%s' '{\"version\":1,\"state\":\"running\"}'".write(to: fixture, atomically: true, encoding: .utf8)
do {
    _ = try await fixtureCommand.run(action: .unload)
    require(false, "successful exit with wrong outcome was accepted")
} catch ServiceCommandError.unexpectedState {}
try "echo 'fixture refusal' >&2; exit 5".write(to: fixture, atomically: true, encoding: .utf8)
do {
    _ = try await fixtureCommand.run(action: .load)
    require(false, "failed process was accepted")
} catch ServiceCommandError.failed(let detail) {
    require(detail == "fixture refusal", "command failure detail lost")
}
print("AgentVoice macOS menu checks passed.")
