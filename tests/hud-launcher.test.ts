import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchHud } from "../src/hud/launcher.ts";

test("named serving delegates fixed local routing to the owned foreground process", async () => {
  let calls = 0;
  const code = await launchHud(
    { PATH: "/fixture", PORTLESS_TAILSCALE: "1", PORTLESS_FUNNEL: "1", PORTLESS_SYNC_HOSTS: "1" },
    {
      which: () => "/fixture/node",
      exists: () => true,
      ready: async () => true,
      run: async (command, args, cwd, env) => {
        calls++;
        expect(command).toBe("/fixture/node");
        expect(args.slice(1, 4)).toEqual(["--name", "agenthud", "--"]);
        expect(args.slice(-2)).toEqual(["serve", "--direct"]);
        expect(cwd.endsWith("/hud")).toBe(true);
        expect(env["PORTLESS_HTTPS"]).toBe("1");
        expect(env["PORTLESS_PORT"]).toBe("443");
        expect(env["PORTLESS_TLD"]).toBe("localhost");
        for (const flag of ["LAN", "WILDCARD", "TAILSCALE", "FUNNEL", "NGROK", "SYNC_HOSTS"])
          expect(env[`PORTLESS_${flag}`]).toBe("0");
        return 0;
      },
    },
  );
  expect(code).toBe(0);
  expect(calls).toBe(1);
});
test("missing shared proxy does not launch or install anything", async () => {
  let launched = false;
  await expect(
    launchHud(
      { PATH: "/fixture" },
      {
        which: () => "/fixture/node",
        exists: () => true,
        ready: async () => false,
        run: async () => {
          launched = true;
          return 0;
        },
      },
    ),
  ).rejects.toThrow("shared portless HTTPS proxy is unavailable");
  expect(launched).toBe(false);
});
test("foreground TERM forwards to owned child and waits for cleanup", async () => {
  const source = resolve(import.meta.dir, "../src/web-serve.ts");
  const worker =
    'process.on("SIGTERM",()=>{console.log("child-cleaned");process.exit(0)});console.log("child-ready");setTimeout(()=>process.exit(1),5000);';
  const script = `import {runForeground} from ${JSON.stringify(source)};process.exitCode=await runForeground(process.execPath,["-e",${JSON.stringify(worker)}],process.cwd(),process.env);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let output = "";
  try {
    while (!output.includes("child-ready")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Child exited before ready");
      output += new TextDecoder().decode(chunk.value);
    }
    child.kill("SIGTERM");
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    expect(await child.exited).toBe(143);
    expect(output).toContain("child-cleaned");
  } finally {
    reader.releaseLock();
    child.kill();
  }
}, 10000);
