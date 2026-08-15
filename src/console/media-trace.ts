export const RTP_STALE_AFTER_MS = 2_000;

interface ReceiveCounters {
  packets: number;
  bytes: number;
}

/** Werift counts transport media before SRTP authentication and inbound RTP after decryption. */
interface TransportReceiveStats extends ReceiveCounters {
  dtlsState: string;
  iceState: string;
  selectedCandidatePairId: string | null;
}

interface InboundRtpStats extends ReceiveCounters {
  streams: number;
  lastPacketAt: number | null;
  packetsLost: number;
  jitterMs: number | null;
}

interface CandidatePairStats extends ReceiveCounters {
  state: string;
  nominated: boolean | null;
  lastPacketAt: number | null;
}

export interface WebRtcMediaSnapshot {
  sampledAt: number;
  connectionState: string;
  iceConnectionState: string;
  transport: TransportReceiveStats | null;
  inboundRtp: InboundRtpStats | null;
  candidatePair: CandidatePairStats | null;
}

export function webRtcMediaSnapshot(
  stats: Iterable<unknown>,
  sampledAt: number,
  connectionState: string,
  iceConnectionState: string,
): WebRtcMediaSnapshot {
  const records = Array.from(stats).filter(isRecord);
  const transports = records.filter((stat) => stat["type"] === "transport");
  const selectedTransport = greatestBy(transports, "packetsReceived");
  const inbound = records.filter(
    (stat) => stat["type"] === "inbound-rtp" && stat["kind"] === "audio",
  );
  const selectedPairId = optionalString(selectedTransport?.["selectedCandidatePairId"]);
  const pairs = records.filter((stat) => stat["type"] === "candidate-pair");
  const selectedPair =
    pairs.find((pair) => selectedPairId !== null && pair["id"] === selectedPairId) ??
    pairs.find((pair) => pair["nominated"] === true) ??
    greatestBy(pairs, "packetsReceived");

  return {
    sampledAt,
    connectionState,
    iceConnectionState,
    transport: selectedTransport
      ? {
          packets: numberOrZero(selectedTransport["packetsReceived"]),
          bytes: numberOrZero(selectedTransport["bytesReceived"]),
          dtlsState: optionalString(selectedTransport["dtlsState"]) ?? "unknown",
          iceState: optionalString(selectedTransport["iceState"]) ?? "unknown",
          selectedCandidatePairId: selectedPairId,
        }
      : null,
    inboundRtp:
      inbound.length === 0
        ? null
        : {
            streams: inbound.length,
            packets: sum(inbound, "packetsReceived"),
            bytes: sum(inbound, "bytesReceived"),
            lastPacketAt: maximumOptional(inbound, "lastPacketReceivedTimestamp"),
            packetsLost: sum(inbound, "packetsLost"),
            jitterMs: latestOptional(inbound, "jitter", "lastPacketReceivedTimestamp", 1_000),
          },
    candidatePair: selectedPair
      ? {
          packets: numberOrZero(selectedPair["packetsReceived"]),
          bytes: numberOrZero(selectedPair["bytesReceived"]),
          state: optionalString(selectedPair["state"]) ?? "unknown",
          nominated: optionalBoolean(selectedPair["nominated"]),
          lastPacketAt: optionalNumber(selectedPair["lastPacketReceivedTimestamp"]),
        }
      : null,
  };
}

export function formatWebRtcMediaTrace(
  current: WebRtcMediaSnapshot,
  previous: WebRtcMediaSnapshot | null,
  generation: number,
  liveMs: number,
): string {
  const transport = current.transport;
  const inbound = current.inboundRtp;
  const pair = current.candidatePair;
  return (
    `voice media generation=${generation} live_ms=${Math.max(0, Math.round(liveMs))} ` +
    `pc_state=${current.connectionState} ice_connection_state=${current.iceConnectionState} ` +
    `dtls_state=${transport?.dtlsState ?? "none"} transport_ice_state=${transport?.iceState ?? "none"} ` +
    `encrypted_packets=${formatOptional(transport?.packets)} encrypted_packets_delta=${formatDelta(transport?.packets, previous?.transport?.packets)} ` +
    `encrypted_bytes=${formatOptional(transport?.bytes)} encrypted_bytes_delta=${formatDelta(transport?.bytes, previous?.transport?.bytes)} ` +
    `decrypted_streams=${inbound?.streams ?? 0} decrypted_rtp_packets=${formatOptional(inbound?.packets)} ` +
    `decrypted_rtp_packets_delta=${formatDelta(inbound?.packets, previous?.inboundRtp?.packets)} ` +
    `decrypted_rtp_bytes=${formatOptional(inbound?.bytes)} decrypted_rtp_bytes_delta=${formatDelta(inbound?.bytes, previous?.inboundRtp?.bytes)} ` +
    `decrypted_last_age_ms=${formatAge(current.sampledAt, inbound?.lastPacketAt)} ` +
    `decrypted_packets_lost=${formatOptional(inbound?.packetsLost)} jitter_ms=${formatFixed(inbound?.jitterMs)} ` +
    `ice_pair_state=${pair?.state ?? "none"} ice_pair_nominated=${formatOptional(pair?.nominated)} ` +
    `ice_packets=${formatOptional(pair?.packets)} ice_packets_delta=${formatDelta(pair?.packets, previous?.candidatePair?.packets)} ` +
    `ice_bytes=${formatOptional(pair?.bytes)} ice_bytes_delta=${formatDelta(pair?.bytes, previous?.candidatePair?.bytes)} ` +
    `ice_last_age_ms=${formatAge(current.sampledAt, pair?.lastPacketAt)}`
  );
}

export function packetAgeMs(now: number, lastPacketAt: number | null): number | null {
  return lastPacketAt === null ? null : Math.max(0, now - lastPacketAt);
}

export function shouldReportRtpStall(
  remoteAttached: boolean,
  lastPacketAgeMs: number | null,
  alreadyReported: boolean,
  staleAfterMs = RTP_STALE_AFTER_MS,
): boolean {
  return (
    remoteAttached &&
    !alreadyReported &&
    lastPacketAgeMs !== null &&
    lastPacketAgeMs >= staleAfterMs
  );
}

type StatsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is StatsRecord {
  return typeof value === "object" && value !== null;
}

function greatestBy(records: readonly StatsRecord[], key: string): StatsRecord | undefined {
  let greatest: StatsRecord | undefined;
  let greatestValue = -Infinity;
  for (const record of records) {
    const value = optionalNumber(record[key]) ?? -Infinity;
    if (!greatest || value > greatestValue) {
      greatest = record;
      greatestValue = value;
    }
  }
  return greatest;
}

function sum(records: readonly StatsRecord[], key: string): number {
  return records.reduce((total, record) => total + numberOrZero(record[key]), 0);
}

function maximumOptional(records: readonly StatsRecord[], key: string): number | null {
  let maximum: number | null = null;
  for (const record of records) {
    const value = optionalNumber(record[key]);
    if (value !== null && (maximum === null || value > maximum)) maximum = value;
  }
  return maximum;
}

function latestOptional(
  records: readonly StatsRecord[],
  valueKey: string,
  timestampKey: string,
  scale: number,
): number | null {
  let latestTimestamp = -Infinity;
  let latestValue: number | null = null;
  for (const record of records) {
    const value = optionalNumber(record[valueKey]);
    if (value === null) continue;
    const timestamp = optionalNumber(record[timestampKey]) ?? -Infinity;
    if (timestamp >= latestTimestamp) {
      latestTimestamp = timestamp;
      latestValue = value * scale;
    }
  }
  return latestValue;
}

function numberOrZero(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function formatOptional(value: number | boolean | null | undefined): string {
  return value === null || value === undefined ? "none" : String(value);
}

function formatDelta(current: number | undefined, previous: number | undefined): string {
  if (current === undefined) return "none";
  return String(previous === undefined ? current : current - previous);
}

function formatAge(now: number, timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return "none";
  return String(Math.round(packetAgeMs(now, timestamp) ?? 0));
}

function formatFixed(value: number | null | undefined): string {
  return value === null || value === undefined ? "none" : value.toFixed(2);
}
