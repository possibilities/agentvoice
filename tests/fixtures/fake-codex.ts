/** A real stdio child for transport tests; no network or credentials. */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
if (mode === "no-initialize") setInterval(() => {}, 1_000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode !== "no-initialize") send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "initialized") {
    send({ method: "test/initialized", params: {} });
  } else if (message.method === "echo") {
    send({ id: message.id, result: message.params });
  } else if (message.method === "test/argv") {
    send({ id: message.id, result: process.argv.slice(2) });
  } else if (message.method === "fragmented") {
    const bytes = Buffer.from(`${JSON.stringify({ id: message.id, result: "voice 🎤 café" })}\n`);
    const split = bytes.indexOf(Buffer.from("🎤")) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
  } else if (message.method === "approval") {
    send({ id: message.id, result: {} });
    send({ id: "approval", method: "item/commandExecution/requestApproval", params: {} });
  } else if (message.method === "notification") {
    send({ id: message.id, result: {} });
    send({ method: message.params.method, params: message.params.params });
  } else if (message.method === "server-request") {
    send({ id: message.id, result: {} });
    send({
      id: "server-request",
      method: message.params.method,
      params: message.params.params ?? {},
    });
  } else if (message.method === "fail") {
    send({ id: message.id, error: { code: 42, message: "refused" } });
  } else if (message.method === "crash") {
    process.exit(7);
  } else if (message.method === "descendant") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    send({ id: message.id, result: { pid: child.pid } });
  } else if (message.method === "invalid") {
    process.stdout.write("not-json\n");
  } else if (message.method === "hang") {
    // No reply: exercise cancellation and request timeout.
  } else if (message.id === "server-request") {
    send({ method: "test/response", params: message });
  } else if (message.id === "approval") {
    send({ method: "test/answer", params: message.result });
  }
});
