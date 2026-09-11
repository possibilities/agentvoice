// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentVoiceMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "AgentVoiceAppCore", targets: ["AgentVoiceAppCore"]),
        .executable(name: "AgentVoiceApp", targets: ["AgentVoiceApp"]),
        .executable(name: "AgentVoiceAppChecks", targets: ["AgentVoiceAppChecks"]),
    ],
    targets: [
        .target(name: "AgentVoiceAppCore"),
        .executableTarget(name: "AgentVoiceApp", dependencies: ["AgentVoiceAppCore"]),
        .executableTarget(
            name: "AgentVoiceAppChecks",
            dependencies: ["AgentVoiceAppCore"],
            path: "Tests/AgentVoiceAppChecks"
        ),
    ],
    swiftLanguageModes: [.v5]
)
