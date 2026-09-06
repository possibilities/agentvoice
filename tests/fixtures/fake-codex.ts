/** A real loopback WebSocket child for transport tests; no external network or credentials. */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";

const mode = process.argv[2];
let capabilities: unknown;
if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
if (mode === "no-initialize") setInterval(() => {}, 1_000);
if (mode === "delayed-shutdown") {
  const hold = setInterval(() => {}, 1_000);
  process.on("SIGTERM", () =>
    setTimeout(() => {
      clearInterval(hold);
      process.exit(0);
    }, 1_200),
  );
}
function handle(peer: ServerWebSocket<undefined>, line: string) {
  const send = (value: unknown) => peer.send(JSON.stringify(value));
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    capabilities = message.params.capabilities;
    if (mode !== "no-initialize") send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "initialized") {
    send({ method: "test/initialized", params: {} });
  } else if (message.method === "echo") {
    send({ id: message.id, result: message.params });
  } else if (message.method === "test/argv") {
    send({ id: message.id, result: process.argv.slice(2) });
  } else if (message.method === "test/capabilities") {
    send({ id: message.id, result: capabilities });
  } else if (message.method === "fragmented") {
    send({ id: message.id, result: "voice 🎤 café" });
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
  } else if (message.method === "detached-descendants") {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("node:child_process");
const nested=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
console.log(nested.pid);
process.on("SIGTERM",()=>{});
setInterval(()=>{},1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (text: string) => {
      send({ id: message.id, result: { pid: child.pid, grandchildPid: Number(text.trim()) } });
    });
  } else if (message.method === "invalid") {
    peer.send("not-json");
  } else if (message.method === "disconnect") {
    peer.close();
  } else if (message.method === "hang") {
    // No reply: exercise cancellation and request timeout.
  } else if (message.id === "server-request") {
    send({ method: "test/response", params: message });
  } else if (message.id === "approval") {
    send({ method: "test/answer", params: message.result });
  }
}
const token = readFileSync(process.argv[process.argv.indexOf("--ws-token-file") + 1]!, "utf8");
const server = Bun.serve<undefined>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response("unauthorized", { status: 401 });
    if (!server.upgrade(request, { data: undefined }))
      return new Response("upgrade required", { status: 400 });
  },
  websocket: {
    message(peer, text) {
      handle(peer, String(text));
    },
  },
});
console.log(`listening on: ws://127.0.0.1:${server.port}`);
