import AgentVoiceAppCore
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

private final class PairPhoneWindow: NSWindow {
    override func cancelOperation(_ sender: Any?) {
        performClose(sender)
    }
}

@MainActor
private final class PairPhoneModel: ObservableObject {
    struct Code {
        enum State {
            case ready
            case activating
            case waiting
        }

        let pairing: PendingPairing
        let image: NSImage
        let state: State

        func changing(to state: State) -> Code {
            Code(pairing: pairing, image: image, state: state)
        }
    }

    enum Phase {
        case idle
        case loading
        case code(Code)
        case paired
        case expired
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    private let client: PairingSocketClient
    private var current: PendingPairing?
    private var polling: Task<Void, Never>?
    private var revision = 0

    init(client: PairingSocketClient = PairingSocketClient()) {
        self.client = client
    }

    func presented() {
        if case .idle = phase { prepare() }
    }

    func retry() {
        let obsolete = reset()
        if let obsolete { Task { await client.cancel(obsolete) } }
        prepare()
    }

    func dismissed() {
        let obsolete = reset()
        phase = .idle
        if let obsolete { Task { await client.cancel(obsolete) } }
    }

    func codeDidRender() {
        guard case .code(let code) = phase, code.state == .ready else { return }
        phase = .code(code.changing(to: .activating))
        let expectedRevision = revision
        Task {
            do {
                let status = try await client.activate(code.pairing)
                guard expectedRevision == revision else { return }
                if status.status == .paired {
                    paired()
                    return
                }
                guard status.status == .waiting else {
                    throw PairingClientError(code: "invalid_response")
                }
                phase = .code(code.changing(to: .waiting))
                poll(code.pairing, revision: expectedRevision)
            } catch {
                guard expectedRevision == revision else { return }
                phase = .failed(error.localizedDescription)
            }
        }
    }

    private func prepare() {
        phase = .loading
        revision += 1
        let expectedRevision = revision
        Task {
            do {
                let pairing = try await client.prepare()
                guard expectedRevision == revision else {
                    await client.cancel(pairing)
                    return
                }
                guard pairing.payload.hasPrefix("agentvoice-pair:v1:"),
                      pairing.payload.utf8.count <= 2_048,
                      pairing.expiresAt > 0,
                      let image = Self.makeCodeImage(pairing.payload)
                else {
                    await client.cancel(pairing)
                    throw PairingClientError(code: "invalid_response")
                }
                current = pairing
                phase = .code(Code(pairing: pairing, image: image, state: .ready))
            } catch {
                guard expectedRevision == revision else { return }
                phase = .failed(error.localizedDescription)
            }
        }
    }

    private func poll(_ pairing: PendingPairing, revision expectedRevision: Int) {
        polling?.cancel()
        polling = Task {
            while !Task.isCancelled, expectedRevision == revision {
                do {
                    try await Task.sleep(for: .milliseconds(500))
                    guard !Task.isCancelled, expectedRevision == revision else { return }
                    if Int64(Date().timeIntervalSince1970 * 1_000) >= pairing.expiresAt {
                        expired()
                        return
                    }
                    let status = try await client.status(pairing)
                    guard !Task.isCancelled, expectedRevision == revision else { return }
                    if status.status == .paired {
                        paired()
                        return
                    }
                    guard status.status == .waiting else {
                        throw PairingClientError(code: "invalid_response")
                    }
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled, expectedRevision == revision else { return }
                    if Int64(Date().timeIntervalSince1970 * 1_000) >= pairing.expiresAt {
                        expired()
                    } else {
                        phase = .failed(error.localizedDescription)
                    }
                    return
                }
            }
        }
    }

    private func paired() {
        polling?.cancel()
        polling = nil
        current = nil
        phase = .paired
    }

    private func expired() {
        polling?.cancel()
        polling = nil
        current = nil
        phase = .expired
    }

    private func reset() -> PendingPairing? {
        revision += 1
        polling?.cancel()
        polling = nil
        defer { current = nil }
        return current
    }

    private static func makeCodeImage(_ payload: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let code = context.createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: code, size: output.extent.size)
    }
}

@MainActor
final class PairPhoneWindowController: NSWindowController, NSWindowDelegate {
    private var hasInitialPosition = false
    private let model = PairPhoneModel()

    init() {
        let size = NSSize(width: 420, height: 540)
        let window = PairPhoneWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = PairPhoneCopy.title
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        window.contentViewController = NSHostingController(
            rootView: PairPhoneView(model: model) { [weak window] in window?.performClose(nil) }
        )
        window.setContentSize(size)
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func present(on screen: NSScreen?) {
        guard let window else { return }
        if !hasInitialPosition {
            let visible = (screen ?? NSScreen.main)?.visibleFrame
            if let visible {
                window.setFrameOrigin(NSPoint(
                    x: visible.midX - window.frame.width / 2,
                    y: visible.midY - window.frame.height / 2
                ))
            } else {
                window.center()
            }
            hasInitialPosition = true
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        model.presented()
        if !NSWorkspace.shared.isVoiceOverEnabled { window.makeFirstResponder(nil) }
    }

    func windowWillClose(_ notification: Notification) {
        model.dismissed()
    }
}

private struct PairPhoneView: View {
    @ObservedObject var model: PairPhoneModel
    let done: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 18) {
                header
                content
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 28)
            .padding(.top, 24)
            .padding(.bottom, 20)

            Divider()
            HStack {
                Spacer()
                Button("Done", action: done)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
        .frame(width: 420, height: 540)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        VStack(spacing: 7) {
            Text(PairPhoneCopy.title)
                .font(.system(size: 22, weight: .semibold))
            Text(PairPhoneCopy.instruction)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            statePanel(icon: "iphone.and.arrow.forward", title: "Preparing a secure code…") {
                ProgressView()
                    .controlSize(.small)
            }
        case .code(let code):
            VStack(spacing: 15) {
                Image(nsImage: code.image)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 224, height: 224)
                    .padding(22)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.black.opacity(0.08), lineWidth: 1)
                    }
                    .shadow(color: Color.black.opacity(0.08), radius: 14, y: 6)
                    .accessibilityLabel("AgentVoice phone pairing QR code")
                    .accessibilityHint("Scan this code with AgentVoice on your phone")
                    .background {
                        PairingDisplayAcknowledgement { model.codeDidRender() }
                    }

                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(code.state == .waiting ? PairPhoneCopy.waiting : "Making the code available…")
                        .font(.system(size: 12, weight: .medium))
                }

                Label(PairPhoneCopy.durableNote, systemImage: "lock.shield")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .paired:
            statePanel(icon: "checkmark.circle.fill", title: PairPhoneCopy.paired) {
                Text(PairPhoneCopy.pairedDetail)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
        case .expired:
            statePanel(icon: "clock.badge.exclamationmark", title: "This code expired") {
                Button("Create New Code") { model.retry() }
            }
        case .failed(let message):
            statePanel(icon: "exclamationmark.triangle", title: "Couldn’t pair your phone") {
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try Again") { model.retry() }
            }
        }
    }

    private func statePanel<Detail: View>(
        icon: String,
        title: String,
        @ViewBuilder detail: () -> Detail
    ) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(size: 15, weight: .semibold))
            VStack(spacing: 12) { detail() }
        }
        .frame(maxWidth: 310, minHeight: 330)
    }
}

private struct PairingDisplayAcknowledgement: NSViewRepresentable {
    let acknowledge: @MainActor () -> Void

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.acknowledge = acknowledge
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.acknowledge = acknowledge
        view.scheduleAcknowledgement()
    }

    @MainActor
    final class ProbeView: NSView {
        var acknowledge: (@MainActor () -> Void)?
        private var scheduled = false
        private var completed = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            scheduleAcknowledgement()
        }

        override func viewDidMoveToSuperview() {
            super.viewDidMoveToSuperview()
            scheduleAcknowledgement()
        }

        func scheduleAcknowledgement() {
            guard !completed, !scheduled, let window, window.isVisible, !window.isMiniaturized,
                  bounds.width > 0, bounds.height > 0
            else { return }
            scheduled = true
            window.displayIfNeeded()
            DispatchQueue.main.async { [weak self, weak window] in
                guard let self, let window, self.window === window, window.isVisible,
                      !window.isMiniaturized, self.bounds.width > 0, self.bounds.height > 0
                else {
                    self?.scheduled = false
                    return
                }
                window.displayIfNeeded()
                self.completed = true
                self.acknowledge?()
            }
        }
    }
}
