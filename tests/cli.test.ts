import { expect, test } from "bun:test";

const entrypoint = new URL("../src/main.ts", import.meta.url).pathname;

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, entrypoint, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

test("bare command shows help and the explicit client remains available", async () => {
  const [bare, client] = await Promise.all([run([]), run(["client", "--help"])]);
  for (const result of [bare, client]) {
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("agentvoice client [--workspace <dir>]");
    expect(result.stdout).toContain("https://agentvoice.localhost");
    expect(result.stderr).toBe("");
  }
});

test("retired terminal composition and attachment forms are rejected", async () => {
  for (const args of [
    ["attach", "agent"],
    ["attach", "voice"],
    ["--attach"],
    ["--workspace", process.cwd()],
  ]) {
    const result = await run(args);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("agentvoice client [--workspace <dir>]");
  }
});

test("web target flags validate before starting a reader or touching routes", async () => {
  const help = await run(["serve", "--help"]);
  expect(help.exit).toBe(0);
  expect(help.stdout).toContain("--workspace <dir> --name <label>");
  const reserved = await run(["serve", "--workspace", process.cwd()]);
  expect(reserved.exit).toBe(2);
  expect(reserved.stderr).toContain("preserve the default route");
  const invalid = await run(["serve", "--name", "a.b"]);
  expect(invalid.exit).not.toBe(0);
  expect(invalid.stderr).toContain("lowercase DNS label");
});
