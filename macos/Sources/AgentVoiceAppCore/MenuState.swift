import Foundation

public enum WaitingServerState: Equatable, Sendable {
    case running
    case loaded(String)
    case unavailable

    public var menuTitle: String {
        switch self {
        case .running:
            return "Waiting server is running"
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
            title = "Open AgentVoice at Login"
            checked = false
            enabled = true
            action = .register
        case .enabled:
            title = "Open AgentVoice at Login"
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
