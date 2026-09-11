import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFrontend } from "../src/frontend/client.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";
import {
  configureNetwork,
  DeviceCredentials,
  disableNetwork,
  endpointSchema,
  loadConnectionProfile,
  loadNetworkSettings,
} from "../src/network/credentials.ts";
import { NetworkGateway } from "../src/network/gateway.ts";
import { NETWORK_SUBPROTOCOL } from "../src/network/protocol.ts";

const endpoint = "wss://voice.example:48414/v2/client";
test("native and browser clients traverse verified WSS; untrusted certificates cannot start calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-test-ca-"));
  try {
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
    const generated = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-days",
        "1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(generated.exitCode).toBe(0);
    for (const trusted of [false, true]) {
      const env = { ...process.env };
      delete env["NODE_TLS_REJECT_UNAUTHORIZED"];
      delete env["NODE_EXTRA_CA_CERTS"];
      if (trusted) env["NODE_EXTRA_CA_CERTS"] = cert;
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./fixtures/network-tls.ts", import.meta.url).pathname,
          key,
          cert,
          trusted ? "trusted" : "untrusted",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => child.kill(), 10000);
      try {
        const [code, out, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, error }).toEqual({ code: 0, error: "" });
        expect(out).toContain("passed");
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("device grants are private, hashed, bounded by expiry and revocable without exposing tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "av-credentials-"));
  try {
    configureNetwork(root, { version: 1, endpoint, port: 44414 });
    configureNetwork(root, { version: 1, endpoint, port: 44414 });
    expect(loadNetworkSettings(root)?.endpoint).toBe(endpoint);
    const credentials = new DeviceCredentials(root);
    const path = join(root, "phone.json");
    const now = Date.now();
    const id = credentials.grant("Phone", endpoint, path, now);
    const profile = loadConnectionProfile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(credentials.authenticate(profile.token, now)).toBe(id);
    expect(credentials.authenticate(`${id}.${"0".repeat(64)}`, now)).toBeUndefined();
    expect(credentials.authenticate(profile.token, now + 30 * 86400_000)).toBeUndefined();
    expect(readFileSync(join(credentials.directory, `${id}.json`), "utf8")).not.toContain(
      profile.token,
    );
    expect(JSON.stringify(credentials.list())).not.toMatch(/token|hash/);
    expect(() => credentials.grant("Again", endpoint, path)).toThrow();
    credentials.revoke(id);
    credentials.revoke(id);
    expect(credentials.authenticate(profile.token)).toBeUndefined();
    expect(credentials.active(id)).toBe(false);
    expect(credentials.list()[0]?.active).toBe(false);
    disableNetwork(root);
    expect(loadNetworkSettings(root)).toBeUndefined();
    configureNetwork(root, { version: 1, endpoint, port: 44415 });
    expect(loadNetworkSettings(root)?.port).toBe(44415);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profiles refuse unsafe permissions, links, invalid endpoints and secret-bearing validation errors", () => {
  const root = mkdtempSync(join(tmpdir(), "av-profile-"));
  try {
    const path = join(root, "phone.json");
    new DeviceCredentials(root).grant("Phone", endpoint, path);
    symlinkSync(path, join(root, "symlink"));
    expect(() => loadConnectionProfile(join(root, "symlink"))).toThrow("unsafe");
    linkSync(path, join(root, "hardlink"));
    expect(() => loadConnectionProfile(path)).toThrow("unsafe");
    rmSync(join(root, "hardlink"));
    chmodSync(path, 0o644);
    expect(() => loadConnectionProfile(path)).toThrow("unsafe");
    chmodSync(path, 0o600);
    writeFileSync(path, '{"token":"DO-NOT-PRINT"}');
    try {
      loadConnectionProfile(path);
      throw new Error("accepted");
    } catch (error) {
      expect(String(error)).not.toContain("DO-NOT-PRINT");
    }
    for (const value of [
      "ws://voice.example/v2/client",
      "wss://user:pass@voice.example/v2/client",
      `${endpoint}?token=secret`,
      `${endpoint}#secret`,
      "wss://voice.example/other",
    ])
      expect(endpointSchema.safeParse(value).success).toBe(false);
    symlinkSync(join(root, "missing"), join(root, "network", "settings.json"));
    expect(() => loadNetworkSettings(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(timings = { interval: 20, timeout: 1000 }) {
  const root = mkdtempSync(join(tmpdir(), "av-network-"));
  let starts = 0;
  let closes = 0;
  const inputs: unknown[] = [];
  const media: unknown[] = [];
  const server = new VoiceServer(frontendSocketPath(root), async () => ({
    state: () => ({
      available: true,
      codingActivity: "unknown" as const,
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
    command: (command) => {
      inputs.push(command);
    },
    clientMedia: (message) => {
      media.push(message);
    },
  }));
  await server.start();
  const credentials = new DeviceCredentials(root);
  const path = join(root, "profile.json");
  const id = credentials.grant("test", endpoint, path);
  const profile = loadConnectionProfile(path);
  const gateway = new NetworkGateway(root, server.path, { version: 1, endpoint, port: 0 }, timings);
  await gateway.start();
  const sockets: WebSocket[] = [];
  async function open(pong = true) {
    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/v2/client`, {
      protocols: [NETWORK_SUBPROTOCOL],
      headers: { Authorization: `Bearer ${profile.token}` },
    });
    sockets.push(ws);
    const ended = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code)),
    );
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "ping" && pong) ws.send(JSON.stringify({ ...frame, type: "pong" }));
      else frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("Handshake failed")));
    });
    let next = 0;
    return {
      ws,
      frames,
      ended,
      request: async (method: string, params?: unknown) => {
        const id = String(++next);
        ws.send(
          JSON.stringify({
            v: 3,
            type: "request",
            id,
            method,
            ...(params === undefined ? {} : { params }),
          }),
        );
        await until(() => frames.some((frame) => frame.type === "response" && frame.id === id));
        return frames.find((frame) => frame.type === "response" && frame.id === id)!;
      },
    };
  }
  return {
    root,
    server,
    gateway,
    credentials,
    id,
    profile,
    open,
    inputs,
    media,
    starts: () => starts,
    closes: () => closes,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await gateway.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("gateway authenticates before local admission and refuses browser origins and wrong protocol/host/path", async () => {
  const f = await fixture();
  try {
    const url = `http://127.0.0.1:${f.gateway.port}/v2/client`;
    const headers = { "sec-websocket-protocol": NETWORK_SUBPROTOCOL };
    expect((await fetch(url, { headers })).status).toBe(401);
    expect(
      (await fetch(url, { headers: { ...headers, authorization: "Bearer invalid" } })).status,
    ).toBe(401);
    expect(
      (await fetch(url, { headers: { ...headers, origin: "https://evil.example" } })).status,
    ).toBe(404);
    expect((await fetch(url, { headers: { ...headers, host: "evil.example" } })).status).toBe(421);
    expect((await fetch(url)).status).toBe(426);
    expect((await fetch(`${url}?token=bad`, { headers })).status).toBe(404);
    expect(f.starts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("network shares local exclusivity, observer restrictions, media/input and disconnect cleanup", async () => {
  const f = await fixture();
  let local: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  try {
    const observer = await f.open();
    expect((await observer.request("observe")).ok).toBe(true);
    expect((await observer.request("call", { clientId: crypto.randomUUID() })).ok).toBe(false);
    const owner = await f.open();
    expect((await owner.request("call", { clientId: crypto.randomUUID() })).ok).toBe(true);
    await until(() => f.starts() === 1);
    await expect(connectFrontend(f.server.path)).rejects.toThrow("busy");
    expect((await observer.request("input", { action: "hold" })).ok).toBe(false);
    expect((await owner.request("input", { action: "hold" })).ok).toBe(true);
    expect(
      (await owner.request("client-media", { type: "connected", sessionId: crypto.randomUUID() }))
        .ok,
    ).toBe(true);
    expect(f.inputs).toContainEqual({ action: "hold" });
    expect(f.media).toHaveLength(1);
    observer.ws.close();
    await observer.ended;
    expect(f.closes()).toBe(0);
    owner.ws.close();
    await owner.ended;
    await until(() => f.closes() === 1);
    local = await connectFrontend(f.server.path);
    const remote = await f.open();
    expect((await remote.request("call", { clientId: crypto.randomUUID() })).ok).toBe(false);
    expect(f.starts()).toBe(2);
  } finally {
    await local?.close();
    await f.close();
  }
});

test("revocation and heartbeat loss tear down active calls, requiring explicit new admission", async () => {
  for (const mode of ["revoke", "heartbeat"] as const) {
    const f = await fixture({ interval: 10, timeout: 80 });
    try {
      const owner = await f.open(mode !== "heartbeat");
      expect((await owner.request("call", { clientId: crypto.randomUUID() })).ok).toBe(true);
      if (mode === "revoke") f.credentials.revoke(f.id);
      expect(await owner.ended).toBe(mode === "revoke" ? 4403 : 4408);
      await until(() => f.closes() === 1);
      expect(f.starts()).toBe(1);
    } finally {
      await f.close();
    }
  }
});

test("gateway bounds device connections and rejects malformed, binary and unsolicited heartbeat frames", async () => {
  const f = await fixture();
  try {
    const peers = await Promise.all([f.open(), f.open(), f.open(), f.open()]);
    await expect(f.open()).rejects.toThrow("Handshake");
    for (const peer of peers) peer.ws.close();
    await Promise.all(peers.map((peer) => peer.ended));
    for (const data of [
      "not json",
      new Uint8Array([1]),
      JSON.stringify({ v: 2, type: "pong", nonce: "0".repeat(32) }),
    ]) {
      const peer = await f.open();
      peer.ws.send(data);
      expect(await peer.ended).toBe(4400);
    }
    expect(f.starts()).toBe(0);
  } finally {
    await f.close();
  }
});
