import Foundation

public enum AgentVoiceMenuCopy {
    public static let pairPhone = "Pair phone…"
    public static let runAtLogin = "Run at login"
    public static let quit = "Quit menu"
}

public enum PairPhonePreviewCopy {
    public static let title = "Pair your phone"
    public static let instruction = "Open AgentVoice on your phone and scan this code."
    public static let securityNote = "Only scan this code with AgentVoice."
    public static let previewNote = "Interaction preview — pairing is not connected yet."

    // Deliberately rejected by the Android grant parser. Replacing this with a
    // real credential requires the private issuance and activation lifecycle.
    public static let payload = "agentvoice-preview:v1:desktop-interaction"
}

public enum WaitingServerState: Equatable, Sendable {
    case running
    case loaded(String)
    case unavailable

    public var menuTitle: String {
        switch self {
        case .running:
            return "AgentVoice is running"
        case .loaded(let state):
            return "Waiting server: \(state)"
        case .unavailable:
            return "Waiting server is not loaded"
        }
    }

    public var accessibilitySummary: String {
        switch self {
        case .running:
            return "AgentVoice, waiting server running"
        case .loaded(let state):
            return "AgentVoice, waiting server \(state)"
        case .unavailable:
            return "AgentVoice, waiting server not loaded"
        }
    }
}

public func parseLaunchctlState(_ output: String) -> WaitingServerState {
    guard let line = output.split(separator: "\n").first(where: {
        $0.trimmingCharacters(in: .whitespaces).hasPrefix("state =")
    }) else {
        return .unavailable
    }
    let value = line.split(separator: "=", maxSplits: 1).last?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if value == "running" { return .running }
    return value.isEmpty ? .unavailable : .loaded(value)
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
            title = "Open Login Item Settings…"
            checked = false
            enabled = true
            action = .openSettings
        case .unavailable:
            title = "Login Item Unavailable"
            checked = false
            enabled = false
            action = .none
        }
    }
}
