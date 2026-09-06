#!/usr/bin/env bun
/**
 * Read-only native WebSocket smoke probe: no turns, audio, or service changes.
 * Also proves the process-local skill root registration roles rely on.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";

const cwd = realpathSync(process.cwd());
const skillsRoot = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-probe-skills-")));
const skillName = "agentvoice-probe-skill";
mkdirSync(join(skillsRoot, skillName));
writeFileSync(
  join(skillsRoot, skillName, "SKILL.md"),
  `---\nname: ${skillName}\ndescription: Disposable probe skill; never invoke.\n---\n`,
);
const connection = await AppServerConnection.connect({
  argv: appServerArgv(process.env["CODEX_PATH"] ?? "codex"),
  nativeStateDir: skillsRoot,
  cwd,
  clientVersion: "websocket-probe",
  onNotification() {},
  onClose() {},
});
try {
  const result = await connection.request<{ data?: unknown[] }>("thread/list", {
    cwd,
    sourceKinds: ["appServer", "vscode"],
    archived: false,
    modelProviders: [],
    sortKey: "updated_at",
    limit: 1,
  });
  if (!Array.isArray(result.data)) throw new Error("thread/list returned no data array");
  console.log("native WebSocket initialize + workspace-filtered thread/list: PASS");

  await connection.request("skills/extraRoots/set", { extraRoots: [skillsRoot] });
  const skills = await connection.request<{
    data?: Array<{ skills?: Array<{ name?: string; path?: string }> }>;
  }>("skills/list", { cwds: [cwd], forceReload: true });
  const found = skills.data?.some((entry) =>
    entry.skills?.some((skill) => skill.name === skillName),
  );
  if (!found) throw new Error(`skills/list did not report ${skillName} from ${skillsRoot}`);
  await connection.request("skills/extraRoots/set", { extraRoots: [] });
  console.log("skills/extraRoots/set + skills/list on an owned child: PASS");
} finally {
  await connection.close();
  rmSync(skillsRoot, { recursive: true, force: true });
}
