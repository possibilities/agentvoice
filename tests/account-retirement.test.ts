import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonConfig, resolveConfig } from "../src/core/config.ts";

async function run(script: string, args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, script), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(5_000),
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

describe("native authentication without an AgentVoice account wrapper", () => {
  test("all retired account sections fail with migration guidance, including false and empty", () => {
    for (const accounts of [
      { balance: true },
      { balance: false },
      { "switch-threshold": 80 },
      {},
      null,
      false,
      3,
      { unexpected: "value" },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ]) {
      const parse = () => parseJsonConfig(JSON.stringify({ accounts }), "settings.json");
      expect(parse).toThrow("settings.json: accounts configuration has been retired");
      expect(parse).toThrow("remove the entire accounts section");
      expect(parse).toThrow("CODEX_HOME");
    }
    expect(resolveConfig({}, {}, {}, "/unused-test-home")).not.toHaveProperty("accounts");
    // Only the app-owned section is retired; native escape hatches stay open.
    const nativeConfig = { accounts: { futureNativeOption: true } };
    expect(
      parseJsonConfig(JSON.stringify({ orchestrator: { config: nativeConfig } }), "settings.json"),
    ).toEqual({ orchestrator: { config: nativeConfig } });
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  test("retired commands and config cannot touch profiles, credentials or history", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-retired-accounts-"));
    const profile = join(root, "agentvoice/accounts/legacy");
    const nativeHome = join(root, "native-home");
    mkdirSync(profile, { recursive: true });
    mkdirSync(nativeHome);
    const auth = "synthetic credential sentinel (not a token)";
    const history = "synthetic native history sentinel";
    writeFileSync(join(profile, "auth.json"), auth);
    writeFileSync(join(nativeHome, "history.jsonl"), history);
    symlinkSync(join(nativeHome, "history.jsonl"), join(profile, "history.jsonl"));
    const configPath = join(root, "server.json");
    const config = JSON.stringify({ accounts: { balance: false } });
    writeFileSync(configPath, config);
    const env = { ...process.env, XDG_STATE_HOME: root, CODEX_HOME: nativeHome };
    try {
      for (const args of [[], ["add", "new"], ["list"], ["--help"], ["help"]]) {
        const result = await run("../src/main.ts", ["accounts", ...args], env);
        expect(result.code).toBe(2);
        expect(result.err).toContain("account management has been retired");
        expect(result.err).toContain("codex login");
        expect(result.err).not.toContain("requires --allow-full-access");
        expect(result.out).toBe("");
      }
      const launch = await run(
        "../src/main.ts",
        [
          "server",
          "--allow-full-access",
          "--config",
          configPath,
          "--codex",
          "/definitely-missing-account-retirement-test-codex",
        ],
        env,
      );
      expect(launch.code).toBe(1);
      expect(launch.err).toContain("accounts configuration has been retired");
      expect(launch.err).not.toContain("could not start");
      expect(launch.out).toBe("");
      expect(readdirSync(join(root, "agentvoice/accounts"))).toEqual(["legacy"]);
      expect(readdirSync(profile).sort()).toEqual(["auth.json", "history.jsonl"]);
      expect(readFileSync(join(profile, "auth.json"), "utf8")).toBe(auth);
      expect(readlinkSync(join(profile, "history.jsonl"))).toBe(join(nativeHome, "history.jsonl"));
      expect(readFileSync(join(nativeHome, "history.jsonl"), "utf8")).toBe(history);
      expect(readFileSync(configPath, "utf8")).toBe(config);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("server calls inherit CODEX_HOME unchanged, or leave it unset for Codex to resolve", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-native-home-"));
    try {
      for (const codexHome of [undefined, join(root, "explicit home")]) {
        // A separate process avoids racing other tests over their environment.
        const env: Record<string, string | undefined> = { ...process.env, XDG_STATE_HOME: root };
        delete env["CODEX_HOME"];
        if (codexHome !== undefined) env["CODEX_HOME"] = codexHome;
        const result = await run("fixtures/native-auth-harness.ts", [], env);
        expect(result.code).toBe(0);
        expect(result.err).toBe("");
        expect(JSON.parse(result.out)).toEqual({
          codexHome: codexHome ?? null,
          hasCodexHome: codexHome !== undefined,
        });
        // Even a nonexistent explicit home is not prepared or replaced by AgentVoice.
        expect(readdirSync(root)).toEqual([]);
      }
      const help = await run("../src/main.ts", ["--help"], process.env);
      expect(help.code).toBe(0);
      expect(help.out).not.toContain("agentvoice accounts");
      expect(help.out).not.toContain("balance");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
