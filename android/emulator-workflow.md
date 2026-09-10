# Historical emulator workflow — superseded

The operator retired emulator use on September 10, 2026 after host disk/memory
pressure. Do not start a VM from this runbook. Use the physical phone in explicit
turns: notify when requesting it, wait for handoff, preserve current Studio and
system settings, and notify when finished. See [current project policy](../AGENTS.md#android-collaboration).
The material below records prior experiments and does not authorize emulators.

# Prior emulator-first Android design and verification

The operator's September 10, 2026 policy is to optimize local emulators and use
them for as much design, iteration and automated verification as possible. Keep
the physical phone available for the human's Studio use. A plugged-in phone is
not an exclusive handoff. This supersedes older guidance to use the phone as the
primary agent preview or not recreate a previously destroyed emulator.

## Check host capacity before starting

Before boot or build, inspect free space on both the system and AVD volumes,
physical RAM, current swap/memory pressure and active VM/build owners. Hardware
acceleration does not make an emulator free: continuous Persona rendering can
consume a core, and guest memory competes with builds and browser processes.
On this 16GB host, do not overlap an emulator with a substantial Gradle build when
memory pressure or heavy swapping is present. Pause the owned emulator, build,
then resume verification; start with fewer cores and modest guest memory when
headroom permits. Do not trade away necessary rendering correctness.

Use the roomy Scratch volume for task AVD userdata and snapshots, never assume
`/tmp` lives there. Stop allocation-heavy work when the system volume is nearly
full; first inventory and clean only owned disposable artifacts. Do not delete
macOS swap, another service's VM images, another agent's caches or user data.
Quick Boot can write a guest-sized snapshot during shutdown, so budget that space
or use `-no-snapshot-save` for a task whose AVD will be deleted anyway.

September10 incident: the system volume had about4GB free and the 16GB Mac had
about12GB swap in use. The owned 3GB/4-core ARM64 emulator was observed at123%CPU
and stopped; its Scratch AVD was deleted. This does not establish the crash cause.
Avoid repeating that combination; emulator-first means optimizing within measured
host capacity, not keeping a VM running regardless of pressure.

## Choose and own a target

Use the official Android Emulator directly on macOS. On Apple Silicon choose an
ARM64 (`arm64-v8a`) system image; on Intel choose x86-64. AgentVoice builds both
ABIs. Avoid CPU translation or a Docker-on-Mac virtualization layer. Android
Studio need not remain open. Discover the installed SDK rather than assuming
`emulator` is on PATH. Use its `emulator -accel-check`; on this ARM64 Mac,
Hypervisor.framework availability was confirmed during this documentation pass.
Acceleration availability alone does not prove the next AVD uses it.

Give each task a unique AVD name and available even emulator port. Record its
name, serial, process, SDK/image/API version, ABI, renderer, viewport/density,
scratch directory and Studio host process/port. One agent owns operations on a
target; collaborators can review captures or run independent source work. Use
additional emulators only when independent work benefits enough to justify CPU,
GPU and memory pressure. Do not reset, stop or adopt somebody else's emulator.

Use `adb -s <exact-serial>` for every operation. Never run device-wide
`connectedAndroidTest`, restart the shared ADB server, or issue untargeted install,
input, rotation, clear-data or force-stop commands while the phone is attached.

## Make the loop fast without reducing design fidelity

- Keep one owned emulator running through the task's edit/build/install/review
  loop. Do not rebuild an AVD, reboot Android or reinstall an unchanged APK for
  each screenshot. Batch scenes and review variants from one build.
- Start with the installed emulator's recommended `-gpu auto`; try `-gpu host`
  and retain it when native Rive/Compose output and stability are verified.
  `-no-window -no-audio -no-boot-anim` avoids a desktop window, host audio and boot
  animation during automation. Use a window only when useful for human review.
  Check the runtime log for the actual renderer and acceleration selection.
- If accelerated rendering fails or corrupts native output, use a supported
  software renderer and record the reason. Consult `emulator -help-gpu`: the
  installed version advertises `software` and `swiftshader`; the older QR run's
  `swiftshader_indirect` invocation is historical, not the default to copy.
  Compare identical native scenes before claiming a performance or fidelity win.
- Size RAM/cores for actual host headroom. More virtual cores, workers or VMs can
  slow the whole machine. Keep SDK images, dependencies and Gradle caches; avoid
  clean builds and shared root-cache deletion. Respect repository Gradle settings
  and other agents' builds. A daemon or worker-count experiment should be scoped,
  measured and coordinated rather than a silent global configuration change.
- Build only relevant variants during iteration (`assembleStudio`, targeted JVM
  tests and `assembleStudioAndroidTest` as needed). Install changed APKs with
  `install -r` to retain the emulator draft. Run relevant native classes by exact
  serial, then required broader checks once after convergence. Production build,
  lint and packaging checks still apply before delivery when that path changed.
- Match the target's logical viewport first. For example, 720×1560 at density320
  and 1080×2340 at density480 both model 360×780dp, but they have different native
  pixels. Use the smaller surface for composition iteration and the intended
  resolution for thin traces, glyphs, glow and native-pixel evidence. Record both
  resolution and density. Do not scale a screenshot and call it native evidence.
- Keep normal animation scales during motion/design review. Reducing animations
  to make tests faster cannot validate breathing, transitions or touch response.
  Test reduced motion separately. Check foreground/lifecycle state and wait for
  concrete readiness instead of long blind sleeps; bound boot and UI waits.

Use Quick Boot or a named clean snapshot when it saves time inside the task.
Snapshot restore rewinds app storage, permissions and preview bindings, not only
Android boot state. Take a baseline before tuning or export a separate task
checkpoint before restoring; never restore over unsaved human work. Keep live
grants and personal accounts out of snapshots. Recreate the synthetic bridge and
verify the target revision after restore. Emulator/image/AVD/renderer changes can
invalidate snapshots; use a cold boot for startup evidence and snapshot diagnosis.
`-no-snapshot` is useful for those checks, not every ordinary iteration.

The shared conversation proposes a persistent leased pool. That is a possible
future optimization, but the operator still requires destroying task-created
emulators when finished. Reuse within a task and retain installed SDK/build
caches; do not silently leave a pool, daemon or task AVD behind. A future pool
needs an explicit lifecycle change and ownership/reset rules.

## Isolate the Studio from the operator

Install the separate Studio APK on the owned emulator. From the repository root:

```sh
bun run android:configure --device <emulator-serial> --port 0 --save-to <absolute-scratch-profile.json>
```

Use the new URL printed by that process. Keep the human's phone host running on
its own port; never restart it to run emulator checks. The emulator has its own
draft, checkpoint, orientation and private synthetic binding. Start from bundled
production, a fixture, or a copy of an explicitly selected saved design. Loading
a profile is not permission to replace the live phone draft. Do not use the
operator's `R5CT91TW4RP.json` as an experiment's output path or promote emulator
edits into production without a design-adoption instruction.

Test both orientations and handedness. Set rotation on the owned emulator and
verify the actual display/configuration and Studio's reported orientation;
rotating a scrcpy window alone proves nothing. Keep orientation epochs and
held-pointer cancellation intact. Capture native stills for layout and short
sequences for motion; inspect both whole composition and 1:1 intersections.

For camera work, use a deterministic noncredential QR fixture and the emulator's
supported virtual/image camera, with no host webcam by default. The QR round
found its image camera cached the file at boot and cropped it differently from
the source canvas: inspect all three finder corners in the actual preview before
blaming the analyzer. Restart only when that fixture/backend requires it. Studio
is intentionally preview-only; production exercises decoding. Test scanner,
verification and storage boundaries separately. Preserve production screenshot
protection and use safe visible UI text for production evidence.

## Reserve phone time for what the emulator cannot establish

Emulators cover most layout, gestures, orientation, persistence, permissions,
native rendering, scanner fixtures and lifecycle regressions. Physical OLED
brightness/color, comfortable touch reach, speaker sound, acoustic microphone
pickup, Bluetooth/audio routing, Samsung-specific behavior and real tailnet
enrollment need their own evidence. Batch those checks after emulator convergence
and request a short exclusive phone handoff. Do independent work while waiting.
Preserve the latest human settings, return the phone promptly and notify them.
Never report a synthetic Connected scene or decoded fixture as a real voice call.

## Finish and record

Record build identity, changed-path checks, scene/viewport/renderer, useful timing
measurements and unresolved hardware limitations. Distinguish measured gains
from proposed optimizations; this policy update did not benchmark a new renderer.
Keep durable learnings in this workflow and the AgentWiki design-studio playbook.

Stop the exact temporary Studio host, shut down the owned serial with
`adb -s <emulator-serial> emu kill`, wait for its process to exit, and delete only
the owned AVD with `avdmanager delete avd -n <owned-name>`. Verify its process,
AVD files and host are absent. Keep source, saved evidence and reusable SDK/build
caches. Do not delete another agent's target or touch the phone during cleanup.

## Sources and evidence

- [Operator-shared conversation: Run Android Apps On Mac](https://chatgpt.com/share/6aa2e6df-4e58-83e9-a4de-79b345b5f03d), read September 10, 2026. Native acceleration, warm reuse and snapshots inform this workflow; its speed rankings are not local benchmarks.
- [Android emulator acceleration](https://developer.android.com/studio/run/emulator-acceleration), [command line](https://developer.android.com/studio/run/emulator-commandline), and [snapshots](https://developer.android.com/studio/run/emulator-snapshots) are the upstream references. Check installed help for version-specific flags.
- Local `emulator -accel-check`, `-help-gpu` and `-help-snapshot` were inspected; no emulator or phone was launched for this docs change.
- [QR enrollment verification](VERIFICATION.md#qr-enrollment-and-complete-studio-setup-rehearsals--september-10-2026) records actual prior native-camera, landscape and cleanup evidence.
