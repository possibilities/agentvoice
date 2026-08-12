import { describe, expect, test } from "bun:test";
import {
  formatWebRtcMediaTrace,
  packetAgeMs,
  shouldReportRtpStall,
  webRtcMediaSnapshot,
} from "../src/client/media-trace.ts";

describe("WebRTC media tracing", () => {
  test("separates encrypted transport progress from decrypted RTP progress", () => {
    const previous = webRtcMediaSnapshot(
      [
        {
          id: "transport-a",
          type: "transport",
          packetsReceived: 500,
          bytesReceived: 60_000,
          dtlsState: "connected",
          iceState: "completed",
          selectedCandidatePairId: "pair-a",
        },
        {
          id: "audio-a",
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived: 480,
          bytesReceived: 40_000,
          packetsLost: 1,
          jitter: 0.004,
          lastPacketReceivedTimestamp: 9_950,
        },
        {
          id: "pair-a",
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          packetsReceived: 520,
          bytesReceived: 65_000,
        },
      ],
      10_000,
      "connected",
      "completed",
    );
    const current = webRtcMediaSnapshot(
      [
        {
          id: "transport-a",
          type: "transport",
          packetsReceived: 550,
          bytesReceived: 66_000,
          dtlsState: "connected",
          iceState: "completed",
          selectedCandidatePairId: "pair-a",
        },
        {
          id: "audio-a",
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived: 480,
          bytesReceived: 40_000,
          packetsLost: 1,
          jitter: 0.004,
          lastPacketReceivedTimestamp: 9_950,
        },
        {
          id: "pair-a",
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          packetsReceived: 570,
          bytesReceived: 71_000,
        },
      ],
      12_100,
      "connected",
      "completed",
    );

    expect(current.transport).toEqual({
      packets: 550,
      bytes: 66_000,
      dtlsState: "connected",
      iceState: "completed",
      selectedCandidatePairId: "pair-a",
    });
    expect(current.inboundRtp).toEqual({
      streams: 1,
      packets: 480,
      bytes: 40_000,
      lastPacketAt: 9_950,
      packetsLost: 1,
      jitterMs: 4,
    });
    const line = formatWebRtcMediaTrace(current, previous, 7, 21_000);
    expect(line).toContain("generation=7 live_ms=21000");
    expect(line).toContain("encrypted_packets_delta=50");
    expect(line).toContain("decrypted_rtp_packets_delta=0");
    expect(line).toContain("decrypted_last_age_ms=2150");
    expect(line).toContain("ice_packets_delta=50");
  });

  test("aggregates audio SSRCs and uses the latest packet for age and jitter", () => {
    const snapshot = webRtcMediaSnapshot(
      [
        {
          id: "old",
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived: 90,
          bytesReceived: 900,
          packetsLost: 2,
          jitter: 0.02,
          lastPacketReceivedTimestamp: 1_000,
        },
        {
          id: "new",
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived: 10,
          bytesReceived: 100,
          packetsLost: 1,
          jitter: 0.003,
          lastPacketReceivedTimestamp: 2_000,
        },
        { id: "video", type: "inbound-rtp", kind: "video", packetsReceived: 999 },
      ],
      2_100,
      "connected",
      "connected",
    );

    expect(snapshot.inboundRtp).toEqual({
      streams: 2,
      packets: 100,
      bytes: 1_000,
      lastPacketAt: 2_000,
      packetsLost: 3,
      jitterMs: 3,
    });
  });
});

describe("RTP callback stall classification", () => {
  test("requires an attached track with a packet older than the threshold", () => {
    expect(packetAgeMs(5_000, null)).toBeNull();
    expect(packetAgeMs(5_000, 5_100)).toBe(0);
    expect(shouldReportRtpStall(false, 3_000, false)).toBe(false);
    expect(shouldReportRtpStall(true, null, false)).toBe(false);
    expect(shouldReportRtpStall(true, 1_999, false)).toBe(false);
    expect(shouldReportRtpStall(true, 2_000, false)).toBe(true);
    expect(shouldReportRtpStall(true, 3_000, true)).toBe(false);
  });
});
