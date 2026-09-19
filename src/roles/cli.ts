import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveConfig } from "../core/config.ts";
import { loadLaunchSource } from "../core/launch-config.ts";
import { resolveRolePath } from "../core/role.ts";
import { prepareRuntime } from "../core/runtime.ts";
import { parseArgs, UsageError } from "../main.ts";
import { dataDirectory, expandTilde } from "../paths.ts";
import { roleImpact } from "./impact.ts";
import {
  adoptRoleFiles,
  canonicalWorkspace,
  captureFiles,
  captureRolePrompts,
  contextWindowSettings,
  createRole,
  preflightRoleAdoption,
  type RoleBundle,
  readRole,
  rolePath,
  writeContextWindow,
  writeVoice,
} from "./store.ts";

const HELP = `agentvoice role — workspace-owned SQLite roles (no audio or inference)

  eject --workspace <dir> [--config <file>] [--role <directory>] [server settings]
      Capture complete settings and role assets once; refuse an existing binding.
  import --workspace <dir> --from <export.sqlite>
      Bind an independent copy of an exported role; refuse an existing binding.
  adopt --workspace <dir> --role <directory|name> --expected-revision <n> [--prompts-only] [--dry-run]
      Update supplied role paths in a new revision; preserve other assets and settings.
      --prompts-only keeps MCP, skills and every other non-prompt asset unchanged.
      Save only: an explicit runtime restart or later server session activates it.
  export --workspace <dir> --output <new.sqlite>
      Export the current revision without workspace binding or operation receipts.
  context-window --workspace <dir> --tokens <n> | --clear --expected-revision <n> [--dry-run]
      Save the native model context window for the next explicit runtime restart.
  status --workspace <dir>
      Show saved role identity, revision and voice.
  voice --workspace <dir> --voice <name> | --clear-voice [--revision <n>]
      Save for the next runtime/server restart; use MCP/API voice_set to reconnect a live call.

Bound workspaces use SQLite, not the original config/prompts/skills. --codex,
--debug and --fast remain local launch controls; source files are not deleted.
Exports carry authored assets, not native login/history or external executables.
`;

export async function validateRoleBundle(bundle: RoleBundle, workspace: string): Promise<void> {
  const config = resolveConfig(
    { orchestrator: { workspace } },
    bundle.settings,
    process.env,
    homedir(),
  );
  config.roleDatabase = {
    path: "",
    snapshot: { ...bundle, ref: { id: randomUUID(), revision: 1 } },
  };
  const snapshot = await prepareRuntime(config);
  snapshot.dispose?.();
}

export async function runRoleCommand(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  if (
    !["eject", "import", "adopt", "export", "status", "voice", "context-window"].includes(command)
  )
    throw new UsageError(HELP);
  const parsed =
    command === "eject"
      ? parseArgs(argv.slice(1))
      : parseArgs(argv.slice(1), {
          value: new Set([
            "--workspace",
            ...(command === "import"
              ? ["--from"]
              : command === "adopt"
                ? ["--role", "--expected-revision"]
                : command === "export"
                  ? ["--output"]
                  : command === "context-window"
                    ? ["--tokens", "--expected-revision"]
                    : command === "voice"
                      ? ["--voice", "--revision"]
                      : []),
          ]),
          bool: new Set(
            command === "context-window"
              ? ["--clear", "--dry-run"]
              : command === "voice"
                ? ["--clear-voice"]
                : command === "adopt"
                  ? ["--dry-run", "--prompts-only"]
                  : [],
          ),
        });
  if (!parsed.values["workspace"])
    throw new UsageError("role commands require --workspace <existing directory>");
  const workspace = canonicalWorkspace(resolve(expandTilde(parsed.values["workspace"], homedir())));
  const path = rolePath(dataDirectory(process.env, homedir()), workspace);
  if (command === "eject") {
    if (parsed.fast !== undefined || parsed.values["device"] || parsed.values["output-device"])
      throw new UsageError("Ejection accepts role settings, not call/device/Fast selection flags");
    const { config, settings } = await loadLaunchSource(parsed);
    // Validate source identity before removing its redundant raw workspace selector.
    const checked = await prepareRuntime(config);
    checked.dispose?.();
    if (settings.orchestrator.extra) delete settings.orchestrator.extra["cwd"];
    const bundle = {
      settings,
      hasRole: config.role !== undefined,
      files: captureFiles(config.role ?? config.configDir, config.role !== undefined),
    };
    await validateRoleBundle(bundle, workspace);
    console.log(JSON.stringify({ workspace, ...createRole(path, bundle) }));
    return 0;
  }
  if (command === "import") {
    if (!parsed.values["from"]) throw new UsageError("import requires --from <export.sqlite>");
    const source = readRole(resolve(expandTilde(parsed.values["from"], homedir())));
    await validateRoleBundle(source, workspace);
    console.log(JSON.stringify({ workspace, ...createRole(path, source) }));
    return 0;
  }
  const before = readRole(path);
  if (command === "context-window") {
    const clear = argv.includes("--clear");
    const rawTokens = parsed.values["tokens"];
    if (clear === (rawTokens !== undefined))
      throw new UsageError("Specify exactly one --tokens <n> or --clear");
    const tokens = clear ? null : Number(rawTokens);
    const expectedRevision = Number(parsed.values["expected-revision"]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new UsageError("context-window requires a positive --expected-revision <n>");
    if (expectedRevision !== before.ref.revision)
      throw new Error("Stale role revision; read status before editing");
    const candidate = { ...before, settings: contextWindowSettings(before.settings, tokens) };
    await validateRoleBundle(candidate, workspace);
    const dryRun = argv.includes("--dry-run");
    const ref = dryRun
      ? { id: before.ref.id, revision: before.ref.revision + 1 }
      : writeContextWindow(path, before.ref.id, expectedRevision, tokens);
    console.log(
      JSON.stringify({
        ...ref,
        previousRevision: before.ref.revision,
        savedContextWindow: tokens,
        dryRun,
        applied: false,
        plan: roleImpact(before, candidate),
      }),
    );
  } else if (command === "adopt") {
    const roleSpec = parsed.values["role"];
    if (!roleSpec) throw new UsageError("adopt requires --role <directory|name>");
    const expectedRevision = Number(parsed.values["expected-revision"]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new UsageError("adopt requires a positive --expected-revision <n>");
    if (expectedRevision !== before.ref.revision)
      throw new Error("Stale role revision; read status before adopting");
    const source = resolveRolePath(roleSpec, process.env, homedir(), process.cwd());
    const promptsOnly = argv.includes("--prompts-only");
    const captured = promptsOnly ? captureRolePrompts(source) : captureFiles(source, true);
    if (captured.length === 0)
      throw new Error(
        promptsOnly ? "Selected role contains no supported prompt files" : "Selected role is empty",
      );
    const sourcePaths = new Set(captured.map((file) => file.path));
    const candidate: RoleBundle = {
      settings: before.settings,
      hasRole: true,
      files: [...before.files.filter((file) => !sourcePaths.has(file.path)), ...captured],
    };
    await validateRoleBundle(candidate, workspace);
    preflightRoleAdoption(path, before.ref.id, expectedRevision, candidate.files);
    const plan = roleImpact(before, candidate);
    const result = {
      workspace,
      role: source,
      mode: promptsOnly ? "prompts" : "all",
      id: before.ref.id,
      previousRevision: before.ref.revision,
      revision: before.ref.revision + 1,
      assets: candidate.files.length,
      sourceAssets: captured.length,
      preservedAssets: before.files.filter((file) => !sourcePaths.has(file.path)).length,
      settingsPreserved: true,
      applied: false,
      plan,
    };
    if (argv.includes("--dry-run")) {
      console.log(JSON.stringify({ ...result, dryRun: true }));
      return 0;
    }
    const ref = adoptRoleFiles(path, before.ref.id, expectedRevision, candidate.files);
    console.log(JSON.stringify({ ...result, ...ref, dryRun: false }));
  } else if (command === "export") {
    if (!parsed.values["output"]) throw new UsageError("export requires --output <new.sqlite>");
    const output = resolve(expandTilde(parsed.values["output"], homedir()));
    console.log(JSON.stringify({ output, ...createRole(output, before, true) }));
  } else if (command === "voice") {
    const clear = argv.includes("--clear-voice");
    const voice = parsed.values["voice"];
    if (
      clear === (voice !== undefined) ||
      (voice !== undefined && (!voice.trim() || voice.length > 128))
    )
      throw new UsageError("Specify exactly one bounded --voice <name> or --clear-voice");
    const revision =
      parsed.values["revision"] === undefined
        ? before.ref.revision
        : Number(parsed.values["revision"]);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new UsageError("Invalid --revision");
    const ref = writeVoice(path, before.ref.id, {
      operationId: randomUUID(),
      expectedInstanceId: `cli-${randomUUID()}`,
      expectedGeneration: 0,
      expectedRoleRevision: revision,
      voice: voice ?? null,
      apply: "next-session",
    });
    console.log(
      JSON.stringify({
        ...ref,
        savedVoice: voice ?? null,
        applied: false,
        plan: roleImpact(before, readRole(path)),
      }),
    );
  } else
    console.log(
      JSON.stringify({
        ...before.ref,
        savedVoice: before.settings.voice?.name ?? null,
        savedContextWindow: before.settings.orchestrator?.config?.["model_context_window"] ?? null,
        assets: before.files.length,
        hasRole: before.hasRole,
      }),
    );
  return 0;
}
