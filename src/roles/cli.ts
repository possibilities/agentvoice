import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveConfig } from "../core/config.ts";
import { loadLaunchSource } from "../core/launch-config.ts";
import { prepareRuntime } from "../core/runtime.ts";
import { parseArgs, UsageError } from "../main.ts";
import { dataDirectory, expandTilde } from "../paths.ts";
import { roleImpact } from "./impact.ts";
import {
  canonicalWorkspace,
  captureFiles,
  createRole,
  type RoleBundle,
  readRole,
  rolePath,
  writeVoice,
} from "./store.ts";

const HELP = `agentvoice role — workspace-owned SQLite roles (no audio or inference)

  eject --workspace <dir> [--config <file>] [--role <directory>] [server settings]
      Capture complete settings and role assets once; refuse an existing binding.
  import --workspace <dir> --from <export.sqlite>
      Bind an independent copy of an exported role; refuse an existing binding.
  export --workspace <dir> --output <new.sqlite>
      Export the current revision without workspace binding or operation receipts.
  status --workspace <dir>
      Show saved role identity, revision and voice.
  voice --workspace <dir> --voice <name> | --clear-voice [--revision <n>]
      Save for the next call/restart; use MCP/API voice_set to reconnect a live call.

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
  if (!["eject", "import", "export", "status", "voice"].includes(command))
    throw new UsageError(HELP);
  const parsed =
    command === "eject"
      ? parseArgs(argv.slice(1))
      : parseArgs(argv.slice(1), {
          value: new Set([
            "--workspace",
            ...(command === "import"
              ? ["--from"]
              : command === "export"
                ? ["--output"]
                : command === "voice"
                  ? ["--voice", "--revision"]
                  : []),
          ]),
          bool: new Set(command === "voice" ? ["--clear-voice"] : []),
        });
  if (!parsed.values["workspace"])
    throw new UsageError("role commands require --workspace <existing directory>");
  const workspace = canonicalWorkspace(resolve(expandTilde(parsed.values["workspace"], homedir())));
  const path = rolePath(dataDirectory(process.env, homedir()), workspace);
  if (command === "eject") {
    if (
      parsed.fast !== undefined ||
      parsed.values["device"] ||
      parsed.values["output-device"] ||
      parsed.values["resume"] ||
      parsed.continue ||
      parsed.fresh
    )
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
  if (command === "export") {
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
        assets: before.files.length,
      }),
    );
  return 0;
}
