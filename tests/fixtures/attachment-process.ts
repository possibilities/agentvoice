#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

appendFileSync(process.env["ATTACHMENT_TEST_PIDS"]!, `${process.pid}\n`);
if (process.argv[2] === "tui") {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25lTUI READY\r\n");
  process.on("SIGTERM", () => {});
  process.stdin.on("data", (data) => {
    if (data.toString().includes("q")) {
      process.stdin.setRawMode(false);
      process.stdout.write("\x1b[?1049l\x1b[?25h");
      process.exit(0);
    }
  });
} else {
  const child = spawn(process.execPath, [import.meta.path, "tui"], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
