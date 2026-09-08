// Isolated subprocess: its generated test CA is trusted only through NODE_EXTRA_CA_CERTS.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { runBrowserFrontend } from "../../src/browser/frontend.ts";
import { connectFrontend } from "../../src/frontend/client.ts";
import type { ServerMediaMessage } from "../../src/frontend/media-protocol.ts";
import { frontendSocketPath } from "../../src/frontend/protocol.ts";
import { VoiceServer } from "../../src/frontend/server.ts";
import { DeviceCredentials, loadConnectionProfile } from "../../src/network/credentials.ts";
import { NetworkGateway } from "../../src/network/gateway.ts";

const root = mkdtempSync(join(tmpdir(), "av-tls-child-"));
let gateway: NetworkGateway;
let tlsConnections = 0;
const tls = createServer(
  { key: readFileSync(process.argv[2]!), cert: readFileSync(process.argv[3]!) },
  (socket) => {
    tlsConnections++;
    const upstream = connect(gateway.port, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  },
);
await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
const address = tls.address();
assert(address && typeof address !== "string");
const endpoint = `wss://localhost:${address.port}/v2/client`;
let starts = 0;
let closes = 0;
let received = 0;
let sendMedia: ((message: ServerMediaMessage) => void) | undefined;
const local = new VoiceServer(frontendSocketPath(root), async (_changed, _params, outgoing) => {
  sendMedia = outgoing;
  return {
    state: () => ({
      available: true,
      phase: "live",
      mic: { muted: true, effectiveMuted: true },
      speaker: { muted: true, effectiveMuted: true },
    }),
    start: async () => {
      starts++;
    },
    close: async () => {
      closes++;
    },
    command() {},
    clientMedia: () => {
      received++;
    },
  };
});
await local.start();
gateway = new NetworkGateway(root, local.path, { version: 1, endpoint, port: 0 });
gateway.start();
const credentials = new DeviceCredentials(root);
credentials.grant("TLS test", endpoint, join(root, "profile.json"));
const profile = loadConnectionProfile(join(root, "profile.json"));
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  assert(predicate(), "Timed out");
};
const abort = new AbortController();
let browser: Promise<void> | undefined;
let ws: WebSocket | undefined;
let browserUrl = "";
try {
  if (process.argv[4] === "untrusted") {
    await assert.rejects(connectFrontend(profile), /Secure connection failed/);
    assert.equal(starts, 0);
  } else {
    const client = await connectFrontend(profile);
    await until(() => starts === 1);
    await client.close();
    await until(() => closes === 1);
    const frames: ServerMediaMessage[] = [];
    browser = runBrowserFrontend(undefined, {
      connection: profile,
      stateDir: root,
      signal: abort.signal,
      write() {},
      open: async (url) => {
        browserUrl = url;
        assert.equal(new URL(url).hostname, "127.0.0.1");
        assert(!url.includes(profile.token));
        ws = new WebSocket(`${url.replace("http:", "ws:")}ws`, {
          headers: { Origin: new URL(url).origin },
        });
        ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
      },
    });
    await until(() => starts === 2);
    const sessionId = crypto.randomUUID();
    sendMedia!({ type: "prepare", sessionId });
    await until(() =>
      frames.some((frame) => frame.type === "prepare" && frame.sessionId === sessionId),
    );
    ws!.send(JSON.stringify({ type: "connected", sessionId }));
    await until(() => received === 1);
    ws!.close();
    await until(() => closes === 2);
    const connectionsBeforeLocal = tlsConnections;
    ws = new WebSocket(`${browserUrl.replace("http:", "ws:")}ws?server=local`, {
      headers: { Origin: new URL(browserUrl).origin },
    });
    await until(() => starts === 3);
    assert.equal(
      tlsConnections,
      connectionsBeforeLocal,
      "Local selection must not connect over TLS",
    );
    ws.close();
    await until(() => closes === 3);
    abort.abort();
    await browser;
  }
  console.log("TLS verification and client lifecycle passed");
} finally {
  abort.abort();
  ws?.terminate();
  await browser?.catch(() => {});
  await gateway.close();
  await local.close();
  tls.close();
  rmSync(root, { recursive: true, force: true });
}
