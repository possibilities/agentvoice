# 0065: Explicit server lifecycle controls in the native menu

Accepted September 14, 2026 through the operator's request to build native
menubar load, unload, and reload controls and normalize its messages. Extends
[0044](0044-native-macos-menu-app.md); its independent menu login item,
server supervision, and distinct signing identities remain. Extends
[0025](0025-launchagent-default-workspaces.md) with non-deleting load and unload.
The installer-controlled menu presence lifecycle is added separately by
[0070](0070-installer-owned-menu-presence.md).

## Decision

Keep this task in the existing AppKit menu. The person needs a status and a few
immediate actions; a separate manager window would add navigation without useful
content. Native menu layout, system type, keyboard navigation and semantic
appearance remain macOS-owned. This follows the task-first hierarchy, restraint,
precise language and native adaptation in the current Vercel design guidance and
the wiki's Vercel design guidance for native fleet apps, consulted September 14.

Use **AgentVoice is unloaded** verbatim. Normalize every menu status, action,
login setting, progress and error into sentence-case human-facing wording; do
not display launchd's raw state strings. Running means only an observed running
server job. Loaded means registration without confirmed running state. Inspection
failure and missing installation are distinct from unloaded.

**Load AgentVoice** loads the existing validated plist and is a no-op if already
loaded. **Unload AgentVoice…** unregisters it without deleting the installation,
logs, settings, runtime or paired devices. It remains unloaded until explicit
load or the next Mac login; there is no new persistent enablement preference.
**Restart AgentVoice…** performs the existing orderly unload/bootstrap sequence.
Use restart rather than reload because this replaces the server and interrupts
retained work; it is not the controller's runtime restart or voice redial.

Restart and unload use native consequence confirmations. Both end attached calls
and stop background work in the default server, including work retained after
frontend detach. They do not affect independently launched workspace servers.
The menu's login option becomes **Show menu at login**, and **Quit AgentVoice
menu** remains independent of the server.

## Ownership and outcomes

The signed menu records a fixed installed service executable and source entrypoint,
not a PATH lookup or arbitrary executable from launchd output. It invokes the
existing `agentvoice service` command. That layer remains the single owner of plist
validation, runtime validation, selected persisted environment, launchctl actions,
and the cross-process operation lock shared with installation. No new supervisor,
call-readiness probe, credentials access, TCC identity or installation mechanism
is introduced. Existing service commands and text output remain compatible;
`--json` adds a versioned status projection without private paths or raw launchd
strings.

Only an observed unloaded state offers load; loaded states offer restart/unload.
Unknown or missing status offers no mutation. A pending operation fences stale
status replies and disables overlapping lifecycle actions and menu quit. Progress
remains visible when reopening the menu. After mutation, the command reports a
fresh snapshot; an unexpected result is not success. Errors reconcile status once,
retain a details action, and never retry a mutation. A bounded command timeout is
an unknown outcome, not proof of failure. The CLI lock remains authoritative even
if the app exits or another caller changes the job.

## Delivery and verification

Service fixtures use fake launchctl and disposable owned files, covering idempotent
load/unload, registration ordering, preserved bytes/environment, missing or edited
installations, ownership, failures, unknown states and shared locking. Swift checks
cover copy, state decoding, action availability and outcome acceptance; the app
and signed bundle build without opening a call or desktop UI. Actual native-menu
light/dark inspection and installed activation require a separately authorized
desktop/service window. The full installer restarts the LaunchAgent and refuses
to replace a changed running menu app, so a staged build alone must not be reported
as activated delivery.
