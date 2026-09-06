import { execFileSync } from "node:child_process";
import { runAttachment } from "../../src/attachment/launcher.ts";

const state = () =>
  execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "inherit"] }).toString();
const before = state();
const code = await runAttachment(
  { workspace: process.cwd() },
  process.env["ATTACHMENT_TEST_STATE"]!,
);
console.log(`ATTACHMENT EXIT ${code}`);
console.log(before === state() ? "TERMINAL RESTORED" : "TERMINAL BROKEN");
process.stdin.setEncoding("utf8");
process.stdin.once("data", (text) => {
  console.log(`TERMINAL INPUT ${String(text).trim()}`);
  process.exit(0);
});
process.stdin.resume();
