import AgentVoiceAppCore
import AppKit
import ServiceManagement

private let serverLabel = "io.arthack.agentvoice.server"

private final class WaitingServerProbe {
    func read(completion: @escaping @Sendable (WaitingServerState) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["print", "gui/\(getuid())/\(serverLabel)"]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else {
                    completion(.unavailable)
                    return
                }
                let text = String(decoding: data, as: UTF8.self)
                completion(parseLaunchctlState(text))
            } catch {
                completion(.unavailable)
            }
        }
    }
}

private final class LoginItemController {
    private static let defaultWasRecordedKey = "loginItemDefaultWasRecorded"
    private let service = SMAppService.mainApp
    private let defaults = UserDefaults.standard

    var state: LoginItemState {
        switch service.status {
        case .notRegistered:
            return .disabled
        case .enabled:
            return .enabled
        case .requiresApproval:
            return .approvalRequired
        case .notFound:
            // A freshly installed main app can report notFound until its first
            // successful registration. Registration is still the correct action.
            return .disabled
        @unknown default:
            return .unavailable
        }
    }

    func perform(_ action: LoginItemAction) throws {
        switch action {
        case .register:
            try service.register()
            defaults.set(true, forKey: Self.defaultWasRecordedKey)
        case .unregister:
            try service.unregister()
            defaults.set(true, forKey: Self.defaultWasRecordedKey)
        case .openSettings:
            SMAppService.openSystemSettingsLoginItems()
        case .none:
            break
        }
    }

    func applyDefaultIfNeeded() {
        let plan = LoginItemDefaultPlan(
            state: state,
            defaultWasRecorded: defaults.bool(forKey: Self.defaultWasRecordedKey)
        )
        guard plan.recordDefault else { return }
        // Record before registration so a transient failure does not create a
        // modal or repeated background-item prompt on every app launch.
        defaults.set(true, forKey: Self.defaultWasRecordedKey)
        if plan.action == .register { try? service.register() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let serverItem = NSMenuItem(title: "Checking waiting server…", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Run AgentVoice at login", action: #selector(toggleLoginItem), keyEquivalent: "")
    private let probe = WaitingServerProbe()
    private let login = LoginItemController()
    private var probeRevision = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        let image = NSImage(systemSymbolName: "waveform.path.ecg", accessibilityDescription: "AgentVoice")?
            .withSymbolConfiguration(configuration)
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.toolTip = "AgentVoice"
        statusItem.button?.setAccessibilityLabel("AgentVoice")

        serverItem.isEnabled = false
        loginItem.target = self
        menu.addItem(serverItem)
        menu.addItem(.separator())
        menu.addItem(loginItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit AgentVoice Menu", action: #selector(quitMenu), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        menu.delegate = self
        // The attached menu owns native tracking and selected highlighting.
        statusItem.menu = menu
        login.applyDefaultIfNeeded()
        refresh()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    private func refresh() {
        let presentation = LoginItemPresentation(state: login.state)
        loginItem.title = presentation.title
        loginItem.state = presentation.checked ? .on : .off
        loginItem.isEnabled = presentation.enabled

        probeRevision += 1
        let revision = probeRevision
        probe.read { [weak self] state in
            DispatchQueue.main.async {
                guard let self, self.probeRevision == revision else { return }
                self.serverItem.title = state.menuTitle
                self.statusItem.button?.toolTip = state.accessibilitySummary
                self.statusItem.button?.setAccessibilityLabel(state.accessibilitySummary)
            }
        }
    }

    @objc private func toggleLoginItem() {
        let presentation = LoginItemPresentation(state: login.state)
        do {
            try login.perform(presentation.action)
            refresh()
        } catch {
            show(error)
        }
    }

    private func show(_ error: Error) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Could Not Change Login Setting"
        alert.informativeText = error.localizedDescription
        alert.runModal()
        refresh()
    }

    @objc private func quitMenu() {
        NSApplication.shared.terminate(nil)
    }
}
