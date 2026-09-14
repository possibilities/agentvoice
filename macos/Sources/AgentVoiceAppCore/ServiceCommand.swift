import Foundation
import Darwin

public enum ServiceCommandError: LocalizedError {
    case installationUnavailable
    case invalidResponse
    case failed(String)
    case timedOut
    case unexpectedState

    public var errorDescription: String? {
        switch self {
        case .installationUnavailable:
            return "The installed AgentVoice command is missing. Reinstall AgentVoice, then check its status again."
        case .invalidResponse:
            return "AgentVoice returned an unreadable status. Check again. If this continues, reinstall AgentVoice."
        case .failed(let detail):
            return "AgentVoice could not complete the request. Check its status before trying again.\n\nDetails: \(detail)"
        case .timedOut:
            return "AgentVoice did not finish in time. The outcome is unknown. Check its status before trying again."
        case .unexpectedState:
            return "The requested server state could not be verified. Check its status before trying again."
        }
    }
}

/// Uses the installation's fixed executable and source, never PATH or a shell.
/// The existing service command owns plist validation and the shared operation lock.
public struct ServiceCommand: Sendable {
    public let executable: String
    public let entrypoint: String

    public init(executable: String, entrypoint: String) {
        self.executable = executable
        self.entrypoint = entrypoint
    }

    public func arguments(action: ServerAction?) -> [String] {
        [entrypoint, "service", action?.rawValue ?? "status", "--json"]
    }

    public func run(action: ServerAction? = nil) async throws -> WaitingServerState {
        try await Task.detached(priority: .utility) {
            guard executable.hasPrefix("/"), entrypoint.hasPrefix("/"),
                  FileManager.default.isExecutableFile(atPath: executable),
                  FileManager.default.fileExists(atPath: entrypoint)
            else { throw ServiceCommandError.installationUnavailable }
            let process = Process()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments(action: action)
            process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output
            process.standardError = output
            try process.run()
            // The service has bounded launchctl calls. This outer bound also covers
            // a stuck interpreter; termination never implies the mutation failed.
            let timeout = DispatchWorkItem {
                if process.isRunning { process.terminate() }
                DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                    if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + (action == nil ? 20 : 240), execute: timeout)
            var data = Data()
            var overflow = false
            while true {
                let chunk = output.fileHandleForReading.readData(ofLength: 4096)
                if chunk.isEmpty { break }
                if data.count + chunk.count <= 65_536 { data.append(chunk) }
                else { overflow = true }
            }
            process.waitUntilExit()
            timeout.cancel()
            guard process.terminationReason == .exit else { throw ServiceCommandError.timedOut }
            guard process.terminationStatus == 0 else {
                throw ServiceCommandError.failed(String(decoding: data.prefix(8192), as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines))
            }
            guard !overflow else { throw ServiceCommandError.invalidResponse }
            let state = try decodeServiceSnapshot(data)
            if let action, !action.accepts(state) { throw ServiceCommandError.unexpectedState }
            return state
        }.value
    }
}
