import { describe, expect, test } from "bun:test";
import {
  expandRouteCandidates,
  parseDiscoveredService,
  profileFromPairComplete,
  selectPairingCandidate,
  validatePairChallenge,
  WebSocketFrames,
} from "../src/console/android-remote.ts";
import { pairingCode, serverIdFromCertificate } from "../src/core/pairing.ts";

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

describe("Android Remote discovery and pairing", () => {
  test("accepts a bounded AgentVoice DNS-SD result and ignores unrelated services", () => {
    expect(
      parseDiscoveredService({
        subscriptionId: "request-1",
        name: "AgentVoice Mac",
        host: "192.168.1.4",
        port: 8473,
        attributes: { v: "1", id: "server-id", tls: "1", pairing: "1", tail: "mac.example.ts.net" },
      }),
    ).toEqual({
      name: "AgentVoice Mac",
      host: "192.168.1.4",
      port: 8473,
      serverId: "server-id",
      pairing: true,
      tailscaleDnsName: "mac.example.ts.net",
    });
    expect(
      parseDiscoveredService({ host: "192.168.1.4", port: 8473, attributes: { v: "2" } }),
    ).toBeNull();
  });

  test("prefers an advertised pairing window but can probe a cached nearby Server", () => {
    const cached = parseDiscoveredService({
      name: "AgentVoice cached",
      host: "192.168.1.2",
      port: 8473,
      attributes: { v: "1", id: "cached-server", tls: "1", pairing: "0" },
    })!;
    const open = parseDiscoveredService({
      name: "AgentVoice pairing",
      host: "192.168.1.3",
      port: 8473,
      attributes: { v: "1", id: "open-server", tls: "1", pairing: "1" },
    })!;

    expect(selectPairingCandidate([cached], null)).toBe(cached);
    expect(selectPairingCandidate([cached, open], "AgentVoice cached")).toBe(open);
  });

  test("recomputes the comparison code and pins exactly the completed Server profile", () => {
    const certificate = "certificate";
    const expected = { deviceId: "device", clientNonce: "client" };
    const challenge = {
      type: "pair-challenge" as const,
      sessionId: "session",
      serverId: serverIdFromCertificate(certificate),
      serverName: "agentvoice",
      certificate,
      deviceId: expected.deviceId,
      clientNonce: expected.clientNonce,
      serverNonce: "server-nonce",
      endpoints: ["mac.example.ts.net"],
      port: 8473,
    };
    expect(validatePairChallenge(challenge, expected)).toBe(pairingCode(challenge));
    expect(
      profileFromPairComplete(
        {
          type: "pair-complete",
          serverId: challenge.serverId,
          serverName: challenge.serverName,
          certificate,
          deviceId: expected.deviceId,
          endpoints: challenge.endpoints,
          port: challenge.port,
        },
        challenge,
      ),
    ).toEqual({
      version: 1,
      serverId: challenge.serverId,
      serverName: "agentvoice",
      certificate,
      deviceId: "device",
      endpoints: ["mac.example.ts.net"],
      port: 8473,
    });
    expect(() => validatePairChallenge({ ...challenge, serverId: "wrong" }, expected)).toThrow(
      "certificate fingerprint",
    );
  });

  test("cancels pending frame deadlines when the pairing socket closes", async () => {
    const socket = new FakeWebSocket();
    const scheduled = Symbol("deadline");
    const cancelled: symbol[] = [];
    const frames = new WebSocketFrames(socket as unknown as WebSocket, {
      schedule: () => scheduled as unknown as ReturnType<typeof setTimeout>,
      cancel: (timer) => cancelled.push(timer as unknown as symbol),
    });

    const pending = frames.next(60_000);
    socket.close();

    await expect(pending).rejects.toThrow("pairing connection closed");
    expect(cancelled).toEqual([scheduled]);
  });
});

describe("pinned route expansion", () => {
  test("keeps addresses, resolves names, and drops what this network cannot resolve", async () => {
    const looked: string[] = [];
    const routes = await expandRouteCandidates(
      ["100.114.244.89", "greybird.example.ts.net", "greybird.local", "fd7a:115c:a1e0::6c3a"],
      async (name) => {
        looked.push(name);
        if (name === "greybird.example.ts.net") return ["100.114.244.89", "fd7a:115c:a1e0::6c3a"];
        throw new Error("unresolvable");
      },
    );
    // Bare-IP URLs are the only shape whose pinned TLS handshake can succeed,
    // so names resolve to addresses and duplicates collapse.
    expect(routes).toEqual(["100.114.244.89", "fd7a:115c:a1e0::6c3a"]);
    expect(looked.sort()).toEqual(["greybird.example.ts.net", "greybird.local"]);
  });

  test("a lookup returning non-addresses contributes nothing", async () => {
    expect(await expandRouteCandidates(["name"], async () => ["not-an-ip", ""])).toEqual([]);
  });
});
