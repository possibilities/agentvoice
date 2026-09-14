import Foundation

public enum AgentVoiceMenuCopy {
    public static let pairPhone = "Pair phone…"
    public static let runAtLogin = "Show menu at login"
    public static let quit = "Quit AgentVoice menu"
}

public enum PairPhoneCopy {
    public static let title = "Pair your phone"
    public static let instruction = "Open AgentVoice on your phone and scan this code."
    public static let waiting = "Waiting for your phone…"
    public static let paired = "Phone paired"
    public static let pairedDetail = "You can now use this phone to call AgentVoice."
    public static let durableNote = "This code expires in 5 minutes. Your phone stays paired until you remove it."
}

public enum WaitingServerState: String, Equatable, Sendable, Decodable {
    case running, loaded, unloaded, notInstalled, unavailable, checking

    public var menuTitle: String {
        switch self {
        case .running: return "AgentVoice is running"
        case .loaded: return "AgentVoice is loaded"
        case .unloaded: return "AgentVoice is unloaded"
        case .notInstalled: return "AgentVoice needs installation"
        case .unavailable: return "AgentVoice status is unavailable"
        case .checking: return "Checking AgentVoice…"
        }
    }

    public var accessibilitySummary: String {
        menuTitle + (self == .running ? ". Server status only; call availability may differ." : "")
    }

    public var actions: [ServerAction] {
        switch self {
        case .running, .loaded: return [.restart, .unload]
        case .unloaded: return [.load]
        case .notInstalled, .unavailable, .checking: return []
        }
    }
}

public enum ServerAction: String, CaseIterable, Sendable {
    case load, restart, unload

    public var title: String {
        switch self {
        case .load: return "Load AgentVoice"
        case .restart: return "Restart AgentVoice…"
        case .unload: return "Unload AgentVoice…"
        }
    }

    public var progress: String {
        switch self {
        case .load: return "Loading AgentVoice…"
        case .restart: return "Restarting AgentVoice…"
        case .unload: return "Unloading AgentVoice…"
        }
    }

    public var failure: String {
        switch self {
        case .load: return "Couldn’t load AgentVoice"
        case .restart: return "Couldn’t restart AgentVoice"
        case .unload: return "Couldn’t unload AgentVoice"
        }
    }

    public var confirmation: String? {
        switch self {
        case .load: return nil
        case .restart:
            return "This ends any call and stops background work in the default server. AgentVoice will then start again. Reconnect from your phone or terminal to call again."
        case .unload:
            return "This ends any call and stops background work in the default server. AgentVoice stays unloaded until you load it again or sign in to your Mac again. Your settings and paired phones are kept."
        }
    }

    public func accepts(_ state: WaitingServerState) -> Bool {
        self == .unload ? state == .unloaded : state == .loaded || state == .running
    }
}

public func decodeServiceSnapshot(_ data: Data) throws -> WaitingServerState {
    struct Snapshot: Decodable { let version: Int; let state: WaitingServerState }
    guard let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
          snapshot.version == 1,
          [.running, .loaded, .unloaded, .notInstalled].contains(snapshot.state)
    else { throw ServiceCommandError.invalidResponse }
    return snapshot.state
}

public enum LoginItemState: Equatable, Sendable {
    case disabled
    case enabled
    case approvalRequired
    case unavailable
}

public enum LoginItemAction: Equatable, Sendable {
    case register
    case unregister
    case openSettings
    case none
}

public struct LoginItemDefaultPlan: Equatable, Sendable {
    public let recordDefault: Bool
    public let action: LoginItemAction

    public init(state: LoginItemState, defaultWasRecorded: Bool) {
        guard !defaultWasRecorded else {
            recordDefault = false
            action = .none
            return
        }
        switch state {
        case .disabled:
            recordDefault = true
            action = .register
        case .enabled, .approvalRequired:
            recordDefault = true
            action = .none
        case .unavailable:
            recordDefault = false
            action = .none
        }
    }
}

public struct LoginItemPresentation: Equatable, Sendable {
    public let title: String
    public let checked: Bool
    public let enabled: Bool
    public let action: LoginItemAction

    public init(title: String, checked: Bool, enabled: Bool, action: LoginItemAction) {
        self.title = title
        self.checked = checked
        self.enabled = enabled
        self.action = action
    }

    public init(state: LoginItemState) {
        switch state {
        case .disabled:
            title = AgentVoiceMenuCopy.runAtLogin
            checked = false
            enabled = true
            action = .register
        case .enabled:
            title = AgentVoiceMenuCopy.runAtLogin
            checked = true
            enabled = true
            action = .unregister
        case .approvalRequired:
            title = "Open login item settings…"
            checked = false
            enabled = true
            action = .openSettings
        case .unavailable:
            title = "Menu login setting is unavailable"
            checked = false
            enabled = false
            action = .none
        }
    }
}
