import AppKit
import Darwin
import Foundation

private let menuControlVersion = 1
private let maximumMenuControlFrameBytes = 65_536
// The installer gives this subprocess seven seconds; keep an outer margin for
// process launch and JSON parsing while still treating a late exit as unknown.
private let menuControlTimeoutSeconds: Int = 5
private let nanosecondsPerSecond: UInt64 = 1_000_000_000

private enum MenuControlFailure: Error {
    case invalidRequest
    case unavailable
    case invalidResponse
    case timedOut
}

private struct MenuSocketIdentity {
    let device: dev_t
    let inode: ino_t
}

private func menuControlStateDirectory() -> String? {
    guard let path = Bundle.main.object(forInfoDictionaryKey: "AgentVoiceStateDirectory") as? String,
          path.hasPrefix("/")
    else { return nil }
    return path
}

private func menuControlSourceRevision() -> String? {
    guard let revision = Bundle.main.object(forInfoDictionaryKey: "AgentVoiceSourceRevision") as? String,
          revision.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil
    else { return nil }
    return revision
}

private func menuControlSocketPath() -> String? {
    menuControlStateDirectory().map {
        URL(fileURLWithPath: $0).appendingPathComponent("menu/control.sock").path
    }
}

private func menuSocketAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw MenuControlFailure.unavailable
    }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        buffer.copyBytes(from: bytes + Array(repeating: 0, count: buffer.count - bytes.count))
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
}

private func configureMenuSocket(_ descriptor: Int32, nonblocking: Bool = false) {
    var yes: Int32 = 1
    _ = setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_NOSIGPIPE,
        &yes,
        socklen_t(MemoryLayout.size(ofValue: yes))
    )
    _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
    if nonblocking { _ = fcntl(descriptor, F_SETFL, O_NONBLOCK) }
    var timeout = timeval(tv_sec: menuControlTimeoutSeconds, tv_usec: 0)
    _ = setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_RCVTIMEO,
        &timeout,
        socklen_t(MemoryLayout.size(ofValue: timeout))
    )
    _ = setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_SNDTIMEO,
        &timeout,
        socklen_t(MemoryLayout.size(ofValue: timeout))
    )
}

private func menuDeadline() -> UInt64 {
    DispatchTime.now().uptimeNanoseconds + UInt64(menuControlTimeoutSeconds) * nanosecondsPerSecond
}

private func waitForMenuSocket(_ descriptor: Int32, event: Int16, deadline: UInt64) throws {
    while true {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now < deadline else { throw MenuControlFailure.timedOut }
        let remaining = deadline - now
        let milliseconds = Int32(min((remaining + 999_999) / 1_000_000, UInt64(Int32.max)))
        var descriptor = pollfd(fd: descriptor, events: event, revents: 0)
        let result = Darwin.poll(&descriptor, 1, milliseconds)
        if result < 0, errno == EINTR { continue }
        guard result > 0 else { throw MenuControlFailure.timedOut }
        if descriptor.revents & event != 0 { return }
        guard descriptor.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0 else {
            throw MenuControlFailure.unavailable
        }
    }
}

private func writeMenuFrame(_ descriptor: Int32, _ value: [String: Any], deadline: UInt64) throws {
    guard JSONSerialization.isValidJSONObject(value) else { throw MenuControlFailure.invalidResponse }
    var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard data.count < maximumMenuControlFrameBytes else { throw MenuControlFailure.invalidResponse }
    data.append(10)
    try data.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
            let sent = Darwin.send(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset, 0)
            if sent < 0, errno == EINTR { continue }
            if sent < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                try waitForMenuSocket(descriptor, event: Int16(POLLOUT), deadline: deadline)
                continue
            }
            guard sent > 0 else { throw MenuControlFailure.unavailable }
            offset += sent
        }
    }
}

private func readMenuFrame(_ descriptor: Int32, deadline: UInt64) throws -> Data {
    var data = Data()
    while data.count < maximumMenuControlFrameBytes {
        var byte: UInt8 = 0
        let count = Darwin.recv(descriptor, &byte, 1, 0)
        if count < 0, errno == EINTR { continue }
        if count < 0, errno == EAGAIN || errno == EWOULDBLOCK {
            try waitForMenuSocket(descriptor, event: Int16(POLLIN), deadline: deadline)
            continue
        }
        guard count > 0 else { throw MenuControlFailure.unavailable }
        if byte == 10 { return data }
        data.append(byte)
    }
    throw MenuControlFailure.invalidResponse
}

private func privateMenuDirectory(_ path: String) throws {
    try FileManager.default.createDirectory(
        atPath: path,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    var information = stat()
    guard lstat(path, &information) == 0,
          information.st_mode & S_IFMT == S_IFDIR,
          information.st_uid == geteuid(),
          information.st_mode & 0o077 == 0
    else { throw MenuControlFailure.unavailable }
}

private func verifyPrivateMenuSocket(_ path: String) throws {
    var information = stat()
    guard lstat(path, &information) == 0,
          information.st_mode & S_IFMT == S_IFSOCK,
          information.st_uid == geteuid(),
          information.st_mode & 0o077 == 0
    else { throw MenuControlFailure.unavailable }
}

private func removeMenuSocket(_ path: String, identity: MenuSocketIdentity?) {
    var information = stat()
    guard let identity,
          lstat(path, &information) == 0,
          information.st_mode & S_IFMT == S_IFSOCK,
          information.st_uid == geteuid(),
          information.st_dev == identity.device,
          information.st_ino == identity.inode
    else { return }
    _ = unlink(path)
}

private func removeStaleMenuSocket(_ path: String) throws {
    var information = stat()
    if lstat(path, &information) != 0 {
        if errno == ENOENT { return }
        throw MenuControlFailure.unavailable
    }
    guard information.st_mode & S_IFMT == S_IFSOCK,
          information.st_uid == geteuid(),
          information.st_mode & 0o077 == 0,
          unlink(path) == 0
    else { throw MenuControlFailure.unavailable }
}

private func peerPID(_ descriptor: Int32) throws -> pid_t {
    var pid: pid_t = 0
    var length = socklen_t(MemoryLayout.size(ofValue: pid))
    guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid > 0 else {
        throw MenuControlFailure.unavailable
    }
    return pid
}

private func sameUserPeer(_ descriptor: Int32) throws -> pid_t {
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(descriptor, &uid, &gid) == 0, uid == geteuid() else {
        throw MenuControlFailure.unavailable
    }
    return try peerPID(descriptor)
}

final class MenuControlServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "io.arthack.agentvoice.menu.control")
    private let closeGroup = DispatchGroup()
    private let prepareQuit: @MainActor () -> Bool
    private let cancelQuit: @MainActor () -> Void
    private let completeQuit: @MainActor () -> Void
    private let revision: String
    private let path: String
    private var listener: Int32 = -1
    private var lockDescriptor: Int32 = -1
    private var source: DispatchSourceRead?
    private var ownsSocket = false
    private var socketIdentity: MenuSocketIdentity?

    @MainActor
    init(
        prepareQuit: @escaping @MainActor () -> Bool,
        cancelQuit: @escaping @MainActor () -> Void,
        completeQuit: @escaping @MainActor () -> Void
    ) throws {
        guard let revision = menuControlSourceRevision(), let path = menuControlSocketPath() else {
            throw MenuControlFailure.unavailable
        }
        self.prepareQuit = prepareQuit
        self.cancelQuit = cancelQuit
        self.completeQuit = completeQuit
        self.revision = revision
        self.path = path
        do {
            try start()
        } catch {
            close()
            throw error
        }
    }

    deinit { close() }

    private func start() throws {
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
        try privateMenuDirectory(directory)
        let lockPath = path + ".lock"
        lockDescriptor = Darwin.open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
        guard lockDescriptor >= 0 else { throw MenuControlFailure.unavailable }
        var lockInformation = stat()
        guard fstat(lockDescriptor, &lockInformation) == 0,
              lockInformation.st_mode & S_IFMT == S_IFREG,
              lockInformation.st_uid == geteuid(),
              lockInformation.st_nlink == 1,
              lockInformation.st_mode & 0o077 == 0,
              flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0
        else { throw MenuControlFailure.unavailable }
        ownsSocket = true

        listener = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw MenuControlFailure.unavailable }
        configureMenuSocket(listener, nonblocking: true)
        try removeStaleMenuSocket(path)
        var address = try menuSocketAddress(path)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { throw MenuControlFailure.unavailable }
        var socketInformation = stat()
        guard lstat(path, &socketInformation) == 0,
              socketInformation.st_mode & S_IFMT == S_IFSOCK,
              socketInformation.st_uid == geteuid()
        else { throw MenuControlFailure.unavailable }
        socketIdentity = MenuSocketIdentity(
            device: socketInformation.st_dev,
            inode: socketInformation.st_ino
        )
        guard chmod(path, 0o600) == 0, Darwin.listen(listener, 4) == 0 else {
            throw MenuControlFailure.unavailable
        }
        let listenerDescriptor = listener
        let heldLockDescriptor = lockDescriptor
        let socketPath = path
        let publishedSocketIdentity = socketIdentity
        let source = DispatchSource.makeReadSource(fileDescriptor: listenerDescriptor, queue: queue)
        self.listener = -1
        self.lockDescriptor = -1
        ownsSocket = false
        self.socketIdentity = nil
        closeGroup.enter()
        source.setEventHandler { [weak self] in self?.acceptClients(listenerDescriptor) }
        source.setCancelHandler { [closeGroup] in
            Darwin.close(listenerDescriptor)
            removeMenuSocket(socketPath, identity: publishedSocketIdentity)
            _ = flock(heldLockDescriptor, LOCK_UN)
            Darwin.close(heldLockDescriptor)
            closeGroup.leave()
        }
        self.source = source
        source.resume()
    }

    func close() {
        if let source {
            self.source = nil
            source.cancel()
            closeGroup.wait()
            return
        }
        if listener >= 0 {
            Darwin.close(listener)
            listener = -1
        }
        if ownsSocket { removeMenuSocket(path, identity: socketIdentity) }
        if lockDescriptor >= 0 {
            _ = flock(lockDescriptor, LOCK_UN)
            Darwin.close(lockDescriptor)
            lockDescriptor = -1
        }
        ownsSocket = false
        socketIdentity = nil
    }

    private func acceptClients(_ listener: Int32) {
        while true {
            let client = Darwin.accept(listener, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                return
            }
            configureMenuSocket(client, nonblocking: true)
            handle(client)
        }
    }

    private func handle(_ client: Int32) {
        let requestID: String
        do {
            _ = try sameUserPeer(client)
            let deadline = menuDeadline()
            let data = try readMenuFrame(client, deadline: deadline)
            guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (request["v"] as? NSNumber)?.intValue == menuControlVersion,
                  request["type"] as? String == "request",
                  let id = request["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
                  request["method"] as? String == "quit_for_update",
                  let params = request["params"] as? [String: Any],
                  params["expectedRevision"] as? String == revision
            else { throw MenuControlFailure.invalidRequest }
            requestID = id
        } catch {
            try? writeMenuFrame(client, [
                "v": menuControlVersion,
                "type": "response",
                "id": "invalid",
                "ok": false,
                "error": ["code": "invalid_request"],
            ], deadline: menuDeadline())
            Darwin.close(client)
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            let accepted = prepareQuit()
            queue.async { [weak self] in
                guard let self else { return }
                var written = true
                do {
                    try writeMenuFrame(client, accepted ? [
                        "v": menuControlVersion,
                        "type": "response",
                        "id": requestID,
                        "ok": true,
                        "result": [
                            "state": "accepted",
                            "pid": Int(getpid()),
                            "sourceRevision": revision,
                        ],
                    ] : [
                        "v": menuControlVersion,
                        "type": "response",
                        "id": requestID,
                        "ok": false,
                        "error": ["code": "busy"],
                    ], deadline: menuDeadline())
                } catch {
                    written = false
                }
                Darwin.close(client)
                if accepted {
                    Task { @MainActor [weak self] in
                        if written { self?.completeQuit() }
                        else { self?.cancelQuit() }
                    }
                }
            }
        }
    }
}

private func menuControlError(_ code: String) -> Int32 {
    let value: [String: Any] = ["version": menuControlVersion, "ok": false, "error": ["code": code]]
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        print(String(decoding: data, as: UTF8.self))
    }
    return 1
}

func runMenuControlCommand(_ arguments: [String]) -> Int32 {
    guard arguments.count == 5,
          arguments[0] == "--menu-control",
          arguments[1] == "quit-for-update",
          arguments[2] == "--expected-revision",
          arguments[4] == "--json",
          arguments[3].range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
          let ownRevision = menuControlSourceRevision(), ownRevision == arguments[3],
          let path = menuControlSocketPath()
    else { return menuControlError("invalid_request") }

    do {
        try verifyPrivateMenuSocket(path)
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw MenuControlFailure.unavailable }
        defer { Darwin.close(descriptor) }
        configureMenuSocket(descriptor, nonblocking: true)
        let deadline = menuDeadline()
        var address = try menuSocketAddress(path)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connected != 0 {
            guard errno == EINPROGRESS else { throw MenuControlFailure.unavailable }
            try waitForMenuSocket(descriptor, event: Int16(POLLOUT), deadline: deadline)
            var socketError: Int32 = 0
            var errorLength = socklen_t(MemoryLayout.size(ofValue: socketError))
            guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socketError, &errorLength) == 0,
                  socketError == 0
            else { throw MenuControlFailure.unavailable }
        }
        let expectedPeer = try peerPID(descriptor)
        let id = UUID().uuidString.lowercased()
        try writeMenuFrame(descriptor, [
            "v": menuControlVersion,
            "type": "request",
            "id": id,
            "method": "quit_for_update",
            "params": ["expectedRevision": ownRevision],
        ], deadline: deadline)
        let data = try readMenuFrame(descriptor, deadline: deadline)
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (response["v"] as? NSNumber)?.intValue == menuControlVersion,
              response["type"] as? String == "response",
              response["id"] as? String == id,
              let ok = response["ok"] as? Bool
        else { throw MenuControlFailure.invalidResponse }
        guard ok,
              let result = response["result"] as? [String: Any],
              result["state"] as? String == "accepted",
              (result["pid"] as? NSNumber)?.int32Value == expectedPeer,
              result["sourceRevision"] as? String == ownRevision
        else {
            let error = response["error"] as? [String: Any]
            return menuControlError(error?["code"] as? String ?? "invalid_response")
        }

        while kill(expectedPeer, 0) == 0 || errno != ESRCH {
            if DispatchTime.now().uptimeNanoseconds >= deadline { throw MenuControlFailure.timedOut }
            usleep(50_000)
        }
        let output: [String: Any] = [
            "version": menuControlVersion,
            "ok": true,
            "state": "stopped",
            "pid": Int(expectedPeer),
            "sourceRevision": ownRevision,
        ]
        let outputData = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        print(String(decoding: outputData, as: UTF8.self))
        return 0
    } catch MenuControlFailure.timedOut {
        return menuControlError("unknown_outcome")
    } catch {
        return menuControlError("unavailable")
    }
}
