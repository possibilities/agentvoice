import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  AppServerClient,
  appServerCommand,
  appServerLaunchCommand,
  descendantProcessIds,
  fxAuthorizedSidecarEnvironment,
} from "../src/app-server.ts";

describe("App Server launch command", () => {
  test("preserves the installed Codex CLI launch by default", () => {
    expect(appServerCommand({ codexPath: "/bin/codex" })).toEqual([
      "/bin/codex",
      "app-server",
      "--enable",
      "realtime_conversation",
      "--stdio",
    ]);
  });

  test("accepts an explicit standalone App Server argv", () => {
    expect(
      appServerCommand({
        command: ["/tmp/codex-app-server", "--listen", "stdio://"],
      }),
    ).toEqual(["/tmp/codex-app-server", "--listen", "stdio://"]);
    expect(() => appServerCommand({ command: [] })).toThrow("cannot be empty");
  });

  test("wraps only the native sidecar profile in the no-fork sandbox", () => {
    expect(
      appServerLaunchCommand(
        {
          command: ["/tmp/codex-voice-sidecar", "--listen", "stdio://"],
          executionProfile: "native-voice-sidecar",
        },
        "/usr/bin/sandbox-exec",
      ),
    ).toEqual([
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1)\n(allow default)\n(deny process-fork)\n",
      "/tmp/codex-voice-sidecar",
      "--listen",
      "stdio://",
    ]);

    expect(
      appServerLaunchCommand(
        {
          command: ["/tmp/codex-app-server", "--listen", "stdio://"],
          executionProfile: "legacy-app-server",
        },
        "/usr/bin/sandbox-exec",
      ),
    ).toEqual(["/tmp/codex-app-server", "--listen", "stdio://"]);
    expect(() =>
      appServerLaunchCommand(
        {
          command: ["/tmp/codex-voice-sidecar", "--listen", "stdio://"],
          executionProfile: "native-voice-sidecar",
        },
        null,
      ),
    ).toThrow("requires /usr/bin/sandbox-exec");
  });

  test("finds descendant PIDs from ps output", () => {
    expect(
      descendantProcessIds(
        `
          100     1
          101   100
          102   101
          103   100
          104   999
        `,
        100,
      ),
    ).toEqual([101, 102, 103]);
  });

  test("drains a final notification emitted immediately before process exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentvoice-app-server-reader-test-"));
    const executable = join(directory, "fake-app-server");
    writeFileSync(executable, fakeAppServerProgram(), { mode: 0o700 });
    chmodSync(executable, 0o700);
    const notifications: string[] = [];
    let client: AppServerClient | null = null;
    try {
      client = await AppServerClient.start({
        command: [executable],
        cwd: directory,
        clientVersion: "test",
        onNotification: (method) => notifications.push(method),
      });
      await client.close();
      expect(notifications).toContain("turn/started");
    } finally {
      await client?.close().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("passes an opaque Duplex only to an authorized sidecar at descriptor 3", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentvoice-authorized-sidecar-test-"));
    const executable = join(directory, "fake-authorized-sidecar");
    writeFileSync(executable, fakeAuthorizedSidecarProgram(), { mode: 0o700 });
    chmodSync(executable, 0o700);
    const broker = spawn(
      process.execPath,
      [
        "-e",
        'const fs = require("node:fs"); async function readAuthority(length) { const bytes = Buffer.alloc(length); for (;;) { try { const count = fs.readSync(3, bytes, 0, length, null); return bytes.subarray(0, count); } catch (error) { if (error.code !== "EAGAIN") throw error; await new Promise((resolve) => setTimeout(resolve, 5)); } } } (async () => { const request = await readAuthority(13); if (request.toString() !== "sidecar-ready") process.exit(12); fs.writeSync(3, "opaque-authority"); setInterval(() => {}, 1000); })()',
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    if (broker.pid === undefined) throw new Error("fake broker failed to spawn");
    const credentialAuthority = broker.stdio[3] as Duplex;
    credentialAuthority.pause();
    const notifications: Record<string, unknown>[] = [];
    let resolveAuthorityObserved: (() => void) | null = null;
    const authorityObserved = new Promise<void>((resolvePromise) => {
      resolveAuthorityObserved = resolvePromise;
    });
    let client: AppServerClient | null = null;
    try {
      client = await AppServerClient.start({
        command: [executable],
        executionProfile: "native-voice-sidecar",
        credentialAuthority,
        cwd: directory,
        clientVersion: "test",
        onNotification(method, params) {
          if (method === "authority/observed") {
            notifications.push(params);
            resolveAuthorityObserved?.();
          }
        },
      });
      await authorityObserved;
      expect(credentialAuthority.destroyed).toBe(true);
      expect(notifications).toEqual([
        { bytes: "opaque-authority", inheritedHome: false, inheritedOpenAiKey: false },
      ]);
    } finally {
      await client?.close().catch(() => {});
      credentialAuthority.destroy();
      broker.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("closes the remaining authority duplicate after an asynchronous spawn failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentvoice-sidecar-spawn-failure-test-"));
    const executable = join(directory, "unused-sidecar");
    writeFileSync(executable, fakeAuthorizedSidecarProgram(), { mode: 0o700 });
    chmodSync(executable, 0o700);
    const broker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    if (broker.pid === undefined) throw new Error("fake broker failed to spawn");
    const credentialAuthority = broker.stdio[3] as Duplex;
    credentialAuthority.pause();

    try {
      await expect(
        AppServerClient.start({
          command: [executable],
          executionProfile: "native-voice-sidecar",
          credentialAuthority,
          cwd: join(directory, "missing-working-directory"),
          clientVersion: "test",
        }),
      ).rejects.toThrow("ENOENT");
      expect(credentialAuthority.destroyed).toBe(true);
    } finally {
      credentialAuthority.destroy();
      broker.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("gives Fx-authorized sidecars no home or inherited credential sources", () => {
    const environment = fxAuthorizedSidecarEnvironment({
      PATH: "/usr/bin",
      TMPDIR: "/tmp/safe-runtime",
      LANG: "en_US.UTF-8",
      HOME: "/Users/operator",
      CODEX_HOME: "/Users/operator/.codex",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      AWS_SHARED_CREDENTIALS_FILE: "/Users/operator/.aws/credentials",
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/operator/google.json",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GITHUB_TOKEN: "github-secret",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      TMPDIR: "/tmp/safe-runtime",
      LANG: "en_US.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
    });
  });
});

function fakeAppServerProgram(): string {
  return `#!/usr/bin/env bun
let remainder = "";
for await (const chunk of Bun.stdin.stream()) {
  remainder += new TextDecoder().decode(chunk);
  for (;;) {
    const newline = remainder.indexOf("\\n");
    if (newline < 0) break;
    const line = remainder.slice(0, newline);
    remainder = remainder.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    }
  }
}
console.log(JSON.stringify({
  jsonrpc: "2.0",
  method: "turn/started",
  params: { threadId: "late-thread", turn: { id: "late-turn" } },
}));
`;
}

function fakeAuthorizedSidecarProgram(): string {
  return `#!/usr/bin/env bun
import { readSync, writeSync } from "node:fs";

async function readAuthority(length) {
  const bytes = Buffer.alloc(length);
  for (;;) {
    try {
      const count = readSync(3, bytes, 0, length, null);
      return bytes.subarray(0, count);
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
      await Bun.sleep(5);
    }
  }
}
writeSync(3, "sidecar-ready");
const bytes = (await readAuthority(16)).toString("utf8");
let remainder = "";
for await (const chunk of Bun.stdin.stream()) {
  remainder += new TextDecoder().decode(chunk);
  for (;;) {
    const newline = remainder.indexOf("\\n");
    if (newline < 0) break;
    const line = remainder.slice(0, newline);
    remainder = remainder.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        method: "authority/observed",
        params: {
          bytes,
          inheritedHome: "HOME" in process.env,
          inheritedOpenAiKey: "OPENAI_API_KEY" in process.env,
        },
      }));
    }
  }
}
`;
}
