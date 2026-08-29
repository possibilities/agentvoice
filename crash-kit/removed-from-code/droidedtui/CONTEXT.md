# Glossary

**Android host.** The reusable native Android process that owns lifecycle, the PTY, terminal emulation, touch translation, and IME visibility. _Avoid:_ wrapper app, shell app.

**App payload.** The compiled Bun executable whose OpenTUI implementation owns everything visible inside the terminal. _Avoid:_ frontend, embedded script.

**Terminal surface.** The Android view that paints Ghostty snapshots and translates touch into terminal mouse input. _Avoid:_ canvas when referring to the whole host view, WebView.

**Terminal resize.** A coalesced PTY window-size update delivered with `TIOCSWINSZ`/`SIGWINCH`; for an IME transition, the Android host emits the final inset layout at animation start. It never restarts the Android host or app payload, and the last complete terminal frame remains presented until a complete post-resize synchronized-output frame arrives. _Avoid:_ reload, relaunch.

**Keyboard request.** An advisory, versioned private OSC emitted by the app payload to ask the active Android host to show or hide the IME. _Avoid:_ keyboard API, Android bridge.

**Host channel.** Bounded request, reply, and event envelopes carried over DroidedTUI's versioned private OSC in both terminal directions. It exposes generic Android host capabilities such as Keystore-backed signing and network-service discovery without exporting native handles or private keys to an app payload. _Avoid:_ JavaScript bridge, AgentVoice bridge, RPC socket.

**Package manifest.** The root `droidedtui.json` file that supplies app identity, version, entrypoint, and Android deployment bounds to the packager and Gradle. _Avoid:_ app config, Gradle metadata.

**Payload launch.** An optional package-manifest instruction that invokes a named export from the app payload's entry module with bounded JSON arguments after OpenTUI initialization. _Avoid:_ entrypoint (the module path), Android bridge.

**Generated Android project.** The self-contained Gradle project recreated under an app's `.droidedtui/android/`; it is DroidedTUI's handoff boundary to ordinary Android tooling. _Avoid:_ wrapper project, template checkout.

**Shared native cache.** The content- and toolchain-keyed store of completed OpenTUI Android libraries outside individual app projects. _Avoid:_ shared build tree, copied Zig checkout.

**Managed Bun toolchain.** The DroidedTUI-pinned, checksum-verified pair of host and Android Bun executables installed atomically in the shared cache for app-payload compilation. _Avoid:_ project Bun, manifest toolchain, bundled runtime.
