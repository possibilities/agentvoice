import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlServer } from "../src/control/index.ts";
import type { ControlBackend, ControlStatus } from "../src/control/types.ts";
import { parseMcpConfigCommand, runMcpConfigCommand } from "../src/main.ts";

function status(instanceId: string, workspace: string, threadId: string): ControlStatus {
  return {
    protocolVersion: 1,
    instanceId,
    workspace,
    threadId,
    generation: 1,
    runtime: { phase: "failed", voicePhase: "failed" },
    recentOperations: [],
  };
}

function backend(current: () => ControlStatus): ControlBackend {
  return {
    status: current,
    async redial() {
      throw new Error("not used");
    },
    async restart() {
      throw new Error("not used");
    },
  };
}

async function exportConfig(
  xdgStateHome: string,
  workspace: string,
  args: string[] = [],
): Promise<string> {
  let output = "";
  const exit = await runMcpConfigCommand(args, {
    launchCwd: workspace,
    home: workspace,
    env: { XDG_STATE_HOME: xdgStateHome },
    write: (text) => {
      output += text;
    },
  });
  expect(exit).toBe(0);
  return output;
}

async function runCli(
  xdgStateHome: string,
  workspace: string,
  args: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/main.ts"), "mcp-config", ...args],
    {
      cwd: workspace,
      env: { ...process.env, XDG_STATE_HOME: xdgStateHome },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

describe("mcp-config", () => {
  test("exports the Agentmux-compatible authenticated JSON for the exact live workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-mcp-config-"));
    const stateDir = join(root, "state", "agentvoice");
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
    const workspace = realpathSync(workspacePath);
    let live = status("instance-a", workspace, "thread-a");
    const server = await startControlServer({
      backend: backend(() => live),
      stateDir,
      instanceId: "instance-a",
    });
    try {
      const records = join(stateDir, "control", "instances");
      expect(statSync(records).mode & 0o777).toBe(0o700);
      const names = readdirSync(records);
      expect(names).toHaveLength(1);
      expect(statSync(join(records, names[0]!)).mode & 0o777).toBe(0o600);
      expect(
        Object.keys(JSON.parse(readFileSync(join(records, names[0]!), "utf8"))).sort(),
      ).toEqual(["controllerPid", "instanceId", "socketPath", "token", "url", "version"]);
      const output = await exportConfig(join(root, "state"), workspace);
      expect(output).toBe(
        `${JSON.stringify(
          {
            mcpServers: {
              agentvoice: {
                type: "http",
                url: server.httpUrl,
                headers: { Authorization: `Bearer ${server.bearerToken}` },
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      expect(await runCli(join(root, "state"), workspace, [])).toEqual({
        exit: 0,
        stdout: output,
        stderr: "",
      });
      live = { ...live, threadId: "thread-after-fresh", runtime: { phase: "failed" } };
      expect(
        JSON.parse(
          await exportConfig(join(root, "state"), workspace, ["--thread", "thread-after-fresh"]),
        ),
      ).toEqual(JSON.parse(output));
      await expect(
        exportConfig(join(root, "state"), workspace, ["--thread", "thread-a"]),
      ).rejects.toThrow("no live AgentVoice controller");
    } finally {
      await server.close();
      expect(readdirSync(join(stateDir, "control", "instances"))).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects workspace ambiguity and selects an exact thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-mcp-ambiguous-"));
    const stateDir = join(root, "state", "agentvoice");
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
    const workspace = realpathSync(workspacePath);
    const first = await startControlServer({
      backend: backend(() => status("one", workspace, "thread-one")),
      stateDir,
      instanceId: "one",
    });
    const second = await startControlServer({
      backend: backend(() => status("two", workspace, "thread-two")),
      stateDir,
      instanceId: "two",
    });
    try {
      await expect(exportConfig(join(root, "state"), workspace)).rejects.toThrow(
        "multiple live AgentVoice controllers",
      );
      const selected = JSON.parse(
        await exportConfig(join(root, "state"), workspace, ["--thread=thread-two"]),
      );
      expect(selected.mcpServers.agentvoice.url).toBe(second.httpUrl);
      expect(selected.mcpServers.agentvoice.url).not.toBe(first.httpUrl);
    } finally {
      await Promise.all([first.close(), second.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores stale and malformed private records but refuses unsafe records and symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-mcp-records-"));
    const workspacePath = join(root, "workspace");
    const records = join(root, "state", "agentvoice", "control", "instances");
    mkdirSync(workspacePath);
    const workspace = realpathSync(workspacePath);
    mkdirSync(records, { recursive: true, mode: 0o700 });
    writeFileSync(join(records, "malformed.json"), "{", { mode: 0o600 });
    const staleId = "stale";
    const staleName = `${createHash("sha256").update(staleId).digest("hex")}.json`;
    writeFileSync(
      join(records, staleName),
      JSON.stringify({
        version: 1,
        instanceId: staleId,
        controllerPid: 2_147_483_647,
        socketPath: join(
          root,
          "state",
          "agentvoice",
          "control",
          `${Bun.hash(staleId).toString(16)}.sock`,
        ),
        url: "http://127.0.0.1:1234/mcp",
        token: "0123456789abcdef",
      }),
      { mode: 0o600 },
    );
    try {
      await expect(exportConfig(join(root, "state"), workspace)).rejects.toThrow(
        "no live AgentVoice controller",
      );
      const unsafe = join(records, "unsafe.json");
      writeFileSync(unsafe, "{}", { mode: 0o600 });
      chmodSync(unsafe, 0o644);
      await expect(exportConfig(join(root, "state"), workspace)).rejects.toThrow(
        "unsafe AgentVoice discovery record",
      );
      rmSync(unsafe);
      symlinkSync(join(records, "malformed.json"), join(records, "linked.json"));
      await expect(exportConfig(join(root, "state"), workspace)).rejects.toThrow(
        "unsafe AgentVoice discovery record",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonicalizes workspace selection and validates command-only flags", () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-mcp-parse-"));
    const workspacePath = join(root, "workspace");
    const alias = join(root, "alias");
    mkdirSync(workspacePath);
    const workspace = realpathSync(workspacePath);
    symlinkSync(workspace, alias);
    try {
      expect(
        parseMcpConfigCommand(["--workspace", "alias", "--thread", "exact"], root, root),
      ).toEqual({ help: false, workspace, threadId: "exact" });
      expect(parseMcpConfigCommand(["--help"], root, root)).toEqual({ help: true });
      expect(() => parseMcpConfigCommand(["--thread="], root, root)).toThrow("non-empty");
      expect(() => parseMcpConfigCommand(["--allow-full-access"], root, root)).toThrow(
        "unknown option",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds every discovery directory entry, including non-record residue", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-mcp-bounded-"));
    const workspacePath = join(root, "workspace");
    const records = join(root, "state", "agentvoice", "control", "instances");
    mkdirSync(workspacePath);
    const workspace = realpathSync(workspacePath);
    mkdirSync(records, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 129; index += 1)
      writeFileSync(join(records, `${index}.tmp`), "", { mode: 0o600 });
    try {
      await expect(exportConfig(join(root, "state"), workspace)).rejects.toThrow(
        "too many AgentVoice discovery entries",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports discovery failure on stderr without launch output", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-mcp-empty-"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
    const workspace = realpathSync(workspacePath);
    try {
      const result = await runCli(join(root, "state"), workspace, []);
      expect(result.exit).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("no live AgentVoice controller");
      expect(result.stderr).not.toContain("requires --allow-full-access");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
