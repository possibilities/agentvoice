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
final class PairPhoneWindowController: NSWindowController {
    private var hasInitialPosition = false

    init() {
        let size = NSSize(width: 420, height: 520)
        let window = PairPhoneWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = PairPhonePreviewCopy.title
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        window.contentViewController = NSHostingController(
            rootView: PairPhoneView { [weak window] in window?.performClose(nil) }
        )
        window.setContentSize(size)
        super.init(window: window)
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
        if !NSWorkspace.shared.isVoiceOverEnabled { window.makeFirstResponder(nil) }
    }
}

private struct PairPhoneView: View {
    let done: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 18) {
                Image(systemName: "iphone")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)

                VStack(spacing: 7) {
                    Text(PairPhonePreviewCopy.title)
                        .font(.system(size: 22, weight: .semibold))
                    Text(PairPhonePreviewCopy.instruction)
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                previewCode

                Label(PairPhonePreviewCopy.securityNote, systemImage: "lock.shield")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 28)
            .padding(.top, 26)

            Spacer(minLength: 20)

            Divider()
            HStack(spacing: 16) {
                Text(PairPhonePreviewCopy.previewNote)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 12)
                Button("Done", action: done)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
        .frame(width: 420, height: 520)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var previewCode: some View {
        Image(nsImage: PairPhonePreviewCode.image)
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
            .accessibilityLabel("Preview pairing QR code")
            .accessibilityHint("This preview code does not create device access")
    }
}

private enum PairPhonePreviewCode {
    static let image: NSImage = {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(PairPhonePreviewCopy.payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return NSImage() }
        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let code = context.createCGImage(output, from: output.extent) else { return NSImage() }
        return NSImage(cgImage: code, size: output.extent.size)
    }()
}
