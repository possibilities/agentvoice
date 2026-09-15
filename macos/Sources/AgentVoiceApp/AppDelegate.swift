import AgentVoiceAppCore
import AppKit
import ServiceManagement

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
    private let serverItem = NSMenuItem(title: WaitingServerState.checking.menuTitle, action: nil, keyEquivalent: "")
    private let pairPhoneItem = NSMenuItem(title: AgentVoiceMenuCopy.pairPhone, action: #selector(showPairPhone), keyEquivalent: "")
    private let loginItem = NSMenuItem(title: AgentVoiceMenuCopy.runAtLogin, action: #selector(toggleLoginItem), keyEquivalent: "")
    private let command = ServiceCommand(
        executable: Bundle.main.object(forInfoDictionaryKey: "AgentVoiceServiceExecutable") as? String ?? "",
        entrypoint: Bundle.main.object(forInfoDictionaryKey: "AgentVoiceServiceEntrypoint") as? String ?? ""
    )
    private var serverState: WaitingServerState = .checking
    private var operation: ServerAction?
    private var confirming = false
    private var lastError: String?
    private var lastFailure: String?
    private var actionItems: [ServerAction: NSMenuItem] = [:]
    private let checkItem = NSMenuItem(title: "Check status again", action: #selector(checkStatus), keyEquivalent: "")
    private let errorItem = NSMenuItem(title: "Show details…", action: #selector(showDetails), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: AgentVoiceMenuCopy.quit, action: #selector(quitMenu), keyEquivalent: "q")
    private let login = LoginItemController()
    private var pairPhoneWindow: PairPhoneWindowController?
    private var probeRevision = 0
    private var checkingStatus = false
    private var quitPrepared = false
    private var menuControl: MenuControlServer?

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
        pairPhoneItem.target = self
        loginItem.target = self
        menu.autoenablesItems = false
        menu.addItem(serverItem)
        for action in ServerAction.allCases {
            let item = NSMenuItem(title: action.title, action: #selector(changeServer(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = action.rawValue
            actionItems[action] = item
            menu.addItem(item)
        }
        checkItem.target = self
        errorItem.target = self
        menu.addItem(checkItem)
        menu.addItem(errorItem)
        menu.addItem(.separator())
        menu.addItem(pairPhoneItem)
        menu.addItem(loginItem)
        menu.addItem(.separator())
        quitItem.target = self
        menu.addItem(quitItem)
        menu.delegate = self
        // The attached menu owns native tracking and selected highlighting.
        statusItem.menu = menu
        do {
            menuControl = try MenuControlServer(
                prepareQuit: { [weak self] in self?.prepareQuit() ?? false },
                cancelQuit: { [weak self] in self?.cancelPreparedQuit() },
                completeQuit: { [weak self] in self?.completePreparedQuit() }
            )
        } catch {
            NSLog("AgentVoice menu update control is unavailable: %@", error.localizedDescription)
        }
        login.applyDefaultIfNeeded()
        refresh()
    }

    func applicationWillTerminate(_ notification: Notification) {
        menuControl?.close()
        menuControl = nil
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    private func refresh() {
        let presentation = LoginItemPresentation(state: login.state)
        loginItem.title = presentation.title
        loginItem.state = presentation.checked ? .on : .off
        loginItem.isEnabled = presentation.enabled

        guard operation == nil, !confirming, !checkingStatus else {
            updateServerMenu()
            return
        }
        checkingStatus = true
        probeRevision += 1
        let revision = probeRevision
        Task {
            defer {
                checkingStatus = false
                updateServerMenu()
            }
            do {
                let state = try await command.run()
                guard probeRevision == revision else { return }
                serverState = state
                if lastFailure == nil { lastError = nil }
                // A fresh status does not erase an operation error the person has
                // not inspected. Starting another explicit action clears it.
            } catch {
                guard probeRevision == revision else { return }
                serverState = .unavailable
                lastError = error.localizedDescription
            }
            updateServerMenu()
        }
        updateServerMenu()
    }

    private func updateServerMenu() {
        let busy = operation != nil || confirming || quitPrepared
        serverItem.title = operation?.progress ?? serverState.menuTitle
        serverItem.toolTip = serverState.accessibilitySummary
        let summary = operation?.progress ?? serverState.accessibilitySummary
        statusItem.button?.toolTip = summary
        statusItem.button?.setAccessibilityLabel(summary)
        for (action, item) in actionItems {
            item.isHidden = !serverState.actions.contains(action)
            item.isEnabled = !busy
        }
        checkItem.isHidden = serverState != .unavailable && lastError == nil
        checkItem.isEnabled = !busy && !checkingStatus
        errorItem.title = lastFailure.map { "\($0)…" } ?? "Show details…"
        errorItem.isHidden = lastError == nil
        errorItem.isEnabled = !busy
        pairPhoneItem.isEnabled = !busy
        quitItem.isEnabled = !busy
    }

    @objc private func checkStatus() { refresh() }

    @objc private func showDetails() {
        guard let lastError else { return }
        showAlert(title: lastFailure ?? "Couldn’t check AgentVoice", detail: lastError)
    }

    @objc private func changeServer(_ sender: NSMenuItem) {
        guard operation == nil, !confirming,
              let raw = sender.representedObject as? String,
              let action = ServerAction(rawValue: raw), serverState.actions.contains(action)
        else { return }
        confirming = true
        probeRevision += 1
        updateServerMenu()
        if let explanation = action.confirmation {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = action.title.replacingOccurrences(of: "…", with: "?")
            alert.informativeText = explanation
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: action.title.replacingOccurrences(of: "…", with: ""))
            guard alert.runModal() == .alertSecondButtonReturn else {
                confirming = false
                refresh()
                return
            }
        }
        confirming = false
        operation = action
        lastError = nil
        lastFailure = nil
        updateServerMenu()
        Task {
            do {
                serverState = try await command.run(action: action)
            } catch {
                lastFailure = action.failure
                lastError = error.localizedDescription
                // Reconcile once after any failure, without retrying the mutation.
                serverState = (try? await command.run()) ?? .unavailable
            }
            operation = nil
            updateServerMenu()
            if let lastError {
                showAlert(title: action.failure, detail: lastError)
            }
        }
    }

    private func showAlert(title: String, detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.runModal()
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

    @objc private func showPairPhone() {
        if pairPhoneWindow == nil { pairPhoneWindow = PairPhoneWindowController() }
        pairPhoneWindow?.present(on: statusItem.button?.window?.screen)
    }

    private func show(_ error: Error) {
        showAlert(title: "Couldn’t change the menu login setting", detail: error.localizedDescription)
        refresh()
    }

    @objc private func quitMenu() {
        guard prepareQuit() else { return }
        completePreparedQuit()
    }

    private func prepareQuit() -> Bool {
        guard operation == nil, !confirming, !quitPrepared else { return false }
        quitPrepared = true
        updateServerMenu()
        return true
    }

    private func completePreparedQuit() {
        guard quitPrepared else { return }
        NSApplication.shared.terminate(nil)
    }

    private func cancelPreparedQuit() {
        guard quitPrepared else { return }
        quitPrepared = false
        updateServerMenu()
    }
}
