import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient, appServerCommand } from "../src/app-server.ts";

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
