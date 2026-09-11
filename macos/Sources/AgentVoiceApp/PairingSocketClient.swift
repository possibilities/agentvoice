import Darwin
import Foundation

private let pairingSocketVersion = 1
private let maximumPairingFrameBytes = 1_048_576

struct PendingPairing: Sendable {
    let enrollmentId: String
    let receipt: String
    let payload: String
    let expiresAt: Int64

    var reference: [String: Any] {
        ["enrollmentId": enrollmentId, "receipt": receipt]
    }
}

struct PairingStatusResponse: Sendable {
    enum Status: String, Sendable {
        case prepared
        case waiting
        case paired
        case cancelled
    }

    let status: Status
    let expiresAt: Int64?
    let deviceId: String?
}

struct PairingClientError: LocalizedError, Sendable {
    let code: String

    var errorDescription: String? {
        switch code {
        case "pairing_unavailable", "service_unavailable":
            return "Phone pairing is not available. Make sure the AgentVoice server is running and its secure phone connection is configured."
        case "pairing_limited":
            return "Too many pairing codes are already open. Close another pairing window or wait a few minutes, then try again."
        default:
            return "AgentVoice could not create a phone pairing code. Try again."
        }
    }
}

private func pairingSocketAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [0]
    guard path.hasPrefix("/"), bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw PairingClientError(code: "service_unavailable")
    }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        buffer.copyBytes(from: bytes + Array(repeating: 0, count: buffer.count - bytes.count))
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
}

private func configurePairingSocket(_ descriptor: Int32) {
    var yes: Int32 = 1
    setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_NOSIGPIPE,
        &yes,
        socklen_t(MemoryLayout.size(ofValue: yes))
    )
    _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_RCVTIMEO,
        &timeout,
        socklen_t(MemoryLayout.size(ofValue: timeout))
    )
    setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_SNDTIMEO,
        &timeout,
        socklen_t(MemoryLayout.size(ofValue: timeout))
    )
}

private func verifyPrivatePairingSocket(_ path: String) throws {
    var information = stat()
    guard lstat(path, &information) == 0,
          information.st_mode & S_IFMT == S_IFSOCK,
          information.st_uid == geteuid(),
          information.st_mode & 0o077 == 0
    else {
        throw PairingClientError(code: "service_unavailable")
    }
}

private func writePairingFrame(_ descriptor: Int32, value: [String: Any]) throws {
    guard JSONSerialization.isValidJSONObject(value) else {
        throw PairingClientError(code: "invalid_request")
    }
    var data = try JSONSerialization.data(withJSONObject: value)
    data.append(10)
    try data.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
            let sent = Darwin.send(
                descriptor,
                buffer.baseAddress!.advanced(by: offset),
                buffer.count - offset,
                0
            )
            if sent < 0, errno == EINTR { continue }
            guard sent > 0 else { throw PairingClientError(code: "service_unavailable") }
            offset += sent
        }
    }
}

private func readPairingFrame(_ descriptor: Int32) throws -> Data {
    var data = Data()
    while data.count < maximumPairingFrameBytes {
        var byte: UInt8 = 0
        let count = Darwin.recv(descriptor, &byte, 1, 0)
        if count < 0, errno == EINTR { continue }
        guard count > 0 else { throw PairingClientError(code: "service_unavailable") }
        if byte == 10 { return data }
        data.append(byte)
    }
    throw PairingClientError(code: "service_unavailable")
}

private func pairingStateDirectory() -> String {
    if let embedded = Bundle.main.object(forInfoDictionaryKey: "AgentVoiceStateDirectory") as? String,
       embedded.hasPrefix("/")
    {
        return embedded
    }
    let environment = ProcessInfo.processInfo.environment
    if let xdg = environment["XDG_STATE_HOME"], xdg.hasPrefix("/") {
        return URL(fileURLWithPath: xdg).appendingPathComponent("agentvoice").path
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/state/agentvoice").path
}

final class PairingSocketClient: @unchecked Sendable {
    private let path: String

    init(path: String = URL(fileURLWithPath: pairingStateDirectory())
        .appendingPathComponent("network/pairing.sock").path)
    {
        self.path = path
    }

    func prepare() async throws -> PendingPairing {
        let result = try await request(method: "prepare", params: [:])
        guard let enrollmentId = result["enrollmentId"] as? String,
              let receipt = result["receipt"] as? String,
              let payload = result["payload"] as? String,
              let expiresAt = (result["expiresAt"] as? NSNumber)?.int64Value
        else {
            throw PairingClientError(code: "invalid_response")
        }
        return PendingPairing(
            enrollmentId: enrollmentId,
            receipt: receipt,
            payload: payload,
            expiresAt: expiresAt
        )
    }

    func activate(_ pairing: PendingPairing) async throws -> PairingStatusResponse {
        try await status(method: "activate", pairing: pairing)
    }

    func status(_ pairing: PendingPairing) async throws -> PairingStatusResponse {
        try await status(method: "status", pairing: pairing)
    }

    func cancel(_ pairing: PendingPairing) async {
        _ = try? await request(method: "cancel", params: pairing.reference)
    }

    private func status(method: String, pairing: PendingPairing) async throws -> PairingStatusResponse {
        let result = try await request(method: method, params: pairing.reference)
        guard let rawStatus = result["status"] as? String,
              let status = PairingStatusResponse.Status(rawValue: rawStatus)
        else {
            throw PairingClientError(code: "invalid_response")
        }
        return PairingStatusResponse(
            status: status,
            expiresAt: (result["expiresAt"] as? NSNumber)?.int64Value,
            deviceId: result["deviceId"] as? String
        )
    }

    private func request(method: String, params: [String: Any]) async throws -> [String: Any] {
        try await Task.detached(priority: .userInitiated) { [path] in
            try Self.blockingRequest(path: path, method: method, params: params)
        }.value
    }

    private static func blockingRequest(
        path: String,
        method: String,
        params: [String: Any]
    ) throws -> [String: Any] {
        try verifyPrivatePairingSocket(path)
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw PairingClientError(code: "service_unavailable") }
        defer { Darwin.close(descriptor) }
        configurePairingSocket(descriptor)
        var address = try pairingSocketAddress(path)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(
                    descriptor,
                    $0,
                    socklen_t(MemoryLayout<sockaddr_un>.size)
                )
            }
        }
        guard connected == 0 else { throw PairingClientError(code: "service_unavailable") }

        let id = UUID().uuidString.lowercased()
        try writePairingFrame(descriptor, value: [
            "v": pairingSocketVersion,
            "type": "request",
            "id": id,
            "method": method,
            "params": params,
        ])
        let data = try readPairingFrame(descriptor)
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (response["v"] as? NSNumber)?.intValue == pairingSocketVersion,
              response["type"] as? String == "response",
              response["id"] as? String == id,
              let ok = response["ok"] as? Bool
        else {
            throw PairingClientError(code: "invalid_response")
        }
        if !ok {
            let error = response["error"] as? [String: Any]
            throw PairingClientError(code: error?["code"] as? String ?? "invalid_response")
        }
        guard let result = response["result"] as? [String: Any] else {
            throw PairingClientError(code: "invalid_response")
        }
        return result
    }
}
