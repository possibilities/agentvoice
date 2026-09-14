#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { z } from "zod";
import { readHud } from "./api.ts";
import { guideEnvelope, hudGuide } from "./guide.ts";
import { launchHud } from "./launcher.ts";
import { runHudMcp } from "./mcp.ts";
import { serveHud } from "./server.ts";
import { WorkError, WorkStore } from "./store.ts";

function usage(): string {
  return `agenthud — ${hudGuide.meta.purpose}\n\n${hudGuide.commands.map((command) => `  ${command.x_usage}\n    ${command.summary}`).join("\n")}\n\n--help-json: command contract; --agent-teaser: short discovery text\n`;
}
function input(args: string[]): unknown {
  if (args.length !== 2 || !["--json", "--file"].includes(args[0] ?? ""))
    throw new WorkError("usage", "Use --json JSON or --file PATH (use - for stdin)");
  const value = args[1] ?? "";
  const raw = args[0] === "--json" ? value : readFileSync(value === "-" ? 0 : value, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new WorkError("invalid_input", "Mutation input exceeds 1 MiB");
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkError("invalid_input", "Input must be valid JSON");
  }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  const print = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "--agent-help") {
    process.stdout.write(`${usage()}\n${hudGuide.guidance}\n`);
    return;
  }
  if (command === "--agent-teaser") {
    process.stdout.write(
      "agenthud: Record durable Work, bind native assignments, review and present results, inspect the local HUD. Start with agenthud guide --json.\n",
    );
    return;
  }
  if (command === "--help-json" || command === "guide") {
    if (rest.length && !(command === "guide" && rest.length === 1 && rest[0] === "--json"))
      throw new WorkError("usage", "Use agenthud guide --json");
    print(guideEnvelope);
    return;
  }
  if (command === "mcp" && !rest.length) {
    await runHudMcp();
    return;
  }
  if (command === "serve") {
    if (!rest.length) {
      process.exitCode = await launchHud();
      return;
    }
    if (rest.length === 1 && rest[0] === "--direct") rest.length = 0;
    if (rest.length && !(rest.length === 2 && rest[0] === "--port"))
      throw new WorkError(
        "usage",
        "Use agenthud serve or agenthud serve --port PORT for direct loopback development",
      );
    const port = Number(rest[1] ?? process.env["PORT"] ?? 4174);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new WorkError("usage", "Port must be 1–65535");
    const server = await serveHud({ port });
    process.stderr.write(`AgentHUD listening on http://127.0.0.1:${port}\n`);
    const stop = () => server.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (!["snapshot", "apply", "batch"].includes(command))
    throw new WorkError("usage", "Unknown command; use agenthud --help");
  if (command === "snapshot" && rest.length && !(rest.length === 1 && rest[0] === "--native"))
    throw new WorkError("usage", "Use agenthud snapshot [--native]");
  const payload = command === "snapshot" ? undefined : input(rest);
  const store = new WorkStore();
  try {
    print(
      command === "snapshot"
        ? rest[0] === "--native"
          ? await readHud(store)
          : store.snapshot()
        : command === "apply"
          ? store.mutate(payload)
          : { records: store.batch(payload) },
    );
  } finally {
    store.close();
  }
}
if (import.meta.main)
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ error: { code: error instanceof WorkError ? error.code : error instanceof z.ZodError ? "invalid_input" : "internal", message: error instanceof Error ? error.message : "HUD command failed" } })}\n`,
    );
    process.exitCode = 1;
  });
