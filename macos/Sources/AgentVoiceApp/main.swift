import AppKit

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--version"] {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
    print("AgentVoice \(version)")
} else if arguments.first == "--menu-control" {
    exit(runMenuControlCommand(arguments))
} else {
    MainActor.assumeIsolated {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { application.run() }
    }
}
