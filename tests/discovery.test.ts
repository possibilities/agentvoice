import { describe, expect, test } from "bun:test";
import { bonjourRegistrationArguments, parseTailscaleStatus } from "../src/server/discovery.ts";

describe("network route publication", () => {
  test("publishes only public identity and route hints in DNS-SD TXT", () => {
    expect(
      bonjourRegistrationArguments({
        name: "AgentVoice Mac",
        port: 8473,
        serverId: "server-id",
        pairing: true,
        tailscaleDnsName: "mac.example.ts.net",
      }),
    ).toEqual([
      "-R",
      "AgentVoice Mac Pairing",
      "_agentvoice._tcp",
      "local",
      "8473",
      "v=1",
      "id=server-id",
      "tls=1",
      "pairing=1",
      "tail=mac.example.ts.net",
    ]);
    expect(
      bonjourRegistrationArguments({
        name: "AgentVoice Mac",
        port: 8473,
        serverId: "server-id",
        pairing: false,
      }),
    ).toEqual([
      "-R",
      "AgentVoice Mac",
      "_agentvoice._tcp",
      "local",
      "8473",
      "v=1",
      "id=server-id",
      "tls=1",
      "pairing=0",
    ]);
  });

  test("uses a distinct bounded browse name while pairing so DNS-SD caches emit a new service", () => {
    expect(
      bonjourRegistrationArguments({
        name: "A".repeat(63),
        port: 8473,
        serverId: "server-id",
        pairing: true,
      })[1],
    ).toBe("AgentVoice Pairing");
  });

  test("extracts stable MagicDNS first, then bounded Tailscale IP routes", () => {
    expect(
      parseTailscaleStatus(
        JSON.stringify({
          Self: {
            DNSName: "mac.tailnet.ts.net.",
            TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2", "not-an-ip"],
          },
        }),
      ),
    ).toEqual(["mac.tailnet.ts.net", "100.64.0.2", "fd7a:115c:a1e0::2"]);
    expect(parseTailscaleStatus("not json")).toEqual([]);
    expect(parseTailscaleStatus(JSON.stringify({ Self: { DNSName: "evil/name" } }))).toEqual([]);
  });
});
