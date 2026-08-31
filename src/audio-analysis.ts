import { createHash } from "node:crypto";

export const AUDIO_ANALYSIS_SCHEMA_VERSION = 1;
export const DEFAULT_ANALYSIS_FRAME_MS = 20;
export const DEFAULT_ACTIVITY_THRESHOLD_DBFS = -50;
export const DEFAULT_ACTIVITY_BRIDGE_MS = 200;
export const DEFAULT_DROPOUT_MIN_MS = 20;
export const DEFAULT_DROPOUT_MAX_MS = 250;

export interface ParsedPcm16Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: 16;
  sampleCountPerChannel: number;
  durationMs: number;
  interleavedPcm: Buffer;
  tracks: Buffer[];
}

export interface AudioAnalysisOptions {
  frameMs?: number;
  activityThresholdDbfs?: number;
  bridgeSilenceMs?: number;
  dropoutMinMs?: number;
  dropoutMaxMs?: number;
  clickDeltaFractionOfFullScale?: number;
}

export interface AudioRegion {
  startSample: number;
  endSample: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface DropoutHeuristic {
  description: string;
  minimumMs: number;
  maximumMs: number;
  candidateCount: number;
  totalCandidateMs: number;
  longestCandidateMs: number;
  candidates: AudioRegion[];
}

export interface PcmTrackAnalysis {
  sampleRate: number;
  sampleCount: number;
  durationMs: number;
  frameMs: number;
  frameSamples: number;
  activityThresholdDbfs: number;
  peakSample: number;
  peakDbfs: number | null;
  overallRmsDbfs: number | null;
  activeRmsDbfs: number | null;
  activeFrameRmsDbfs: {
    p10: number | null;
    p50: number | null;
    p95: number | null;
  };
  crestFactorDb: number | null;
  dcOffset: number;
  clippedSampleCount: number;
  clippedSampleRatio: number;
  clickDeltaThreshold: number;
  clickCandidateCount: number;
  frameCount: number;
  activeFrameCount: number;
  silentFrameCount: number;
  activeDurationMs: number;
  activeTimelineRatio: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  activityRegions: AudioRegion[];
  interiorPauses: AudioRegion[];
  dropoutHeuristic: DropoutHeuristic;
}

export interface DuplexActivityAnalysis {
  resolutionMs: number;
  resolutionSamples: number;
  windowCount: number;
  inputOnlyMs: number;
  outputOnlyMs: number;
  simultaneousAudibleMs: number;
  neitherAudibleMs: number;
  simultaneousShareOfInputActivity: number;
  simultaneousShareOfOutputActivity: number;
}

export interface WavAudioAnalysis {
  schemaVersion: typeof AUDIO_ANALYSIS_SCHEMA_VERSION;
  sha256: string;
  format: {
    codec: "pcm_s16le";
    sampleRate: number;
    channels: number;
    bitsPerSample: 16;
    sampleCountPerChannel: number;
    durationMs: number;
  };
  tracks: PcmTrackAnalysis[];
  duplex: DuplexActivityAnalysis | null;
}

export interface TimedAudioEvent {
  seq: number;
  atMs: number;
  source: string;
  type: string;
  data: Record<string, unknown>;
}

export interface BlindAudioClip {
  id: "output-quality" | "conversation-timing" | "steering-interaction" | "final-exchange";
  source: "output.wav" | "comparison.wav";
  purpose: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface BlindAudioClipPlan {
  schemaVersion: 1;
  artifactDurationMs: number;
  timelineAlignment: {
    journalToAudioOffsetMs: number;
    source: "input-start-samples" | "media.peer.connecting" | "assumed-zero";
  };
  clips: BlindAudioClip[];
}

/** Parse and strictly validate an uncompressed, little-endian, 16-bit PCM WAV. */
export function parsePcm16Wav(wav: Buffer): ParsedPcm16Wav {
  if (wav.length < 12) throw new Error("WAV is shorter than its RIFF header");
  if (wav.toString("ascii", 0, 4) !== "RIFF") throw new Error("WAV is missing RIFF magic");
  if (wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("RIFF payload is not WAVE");

  const declaredFileBytes = wav.readUInt32LE(4) + 8;
  if (declaredFileBytes !== wav.length) {
    throw new Error(
      `RIFF length declares ${declaredFileBytes} bytes, but buffer contains ${wav.length}`,
    );
  }

  let offset = 12;
  let format: Buffer | null = null;
  const dataChunks: Buffer[] = [];
  while (offset < wav.length) {
    if (offset + 8 > wav.length) throw new Error(`truncated WAV chunk header at byte ${offset}`);
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > wav.length) {
      throw new Error(`WAV chunk ${JSON.stringify(id)} exceeds the RIFF payload`);
    }
    if (id === "fmt ") {
      if (format) throw new Error("WAV contains more than one fmt chunk");
      format = wav.subarray(payloadStart, payloadEnd);
    } else if (id === "data") {
      dataChunks.push(wav.subarray(payloadStart, payloadEnd));
    }
    offset = payloadEnd + (size % 2);
  }
  if (offset !== wav.length) throw new Error("WAV ends inside a padded chunk");
  if (!format) throw new Error("WAV is missing its fmt chunk");
  if (format.length < 16) throw new Error("WAV fmt chunk is shorter than 16 bytes");
  if (dataChunks.length === 0) throw new Error("WAV is missing its data chunk");

  const audioFormat = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const byteRate = format.readUInt32LE(8);
  const blockAlign = format.readUInt16LE(12);
  const bitsPerSample = format.readUInt16LE(14);
  if (audioFormat !== 1) throw new Error(`WAV format ${audioFormat} is not integer PCM`);
  if (channels < 1) throw new Error("WAV channel count must be positive");
  if (sampleRate < 1) throw new Error("WAV sample rate must be positive");
  if (bitsPerSample !== 16) throw new Error(`WAV has ${bitsPerSample}-bit samples; expected 16`);
  if (blockAlign !== channels * 2) {
    throw new Error(`WAV block alignment is ${blockAlign}; expected ${channels * 2}`);
  }
  if (byteRate !== sampleRate * blockAlign) {
    throw new Error(`WAV byte rate is ${byteRate}; expected ${sampleRate * blockAlign}`);
  }

  const interleavedPcm = Buffer.concat(dataChunks);
  if (interleavedPcm.length === 0) throw new Error("WAV data is empty");
  if (interleavedPcm.length % blockAlign !== 0) {
    throw new Error("WAV data does not end on a complete interleaved sample frame");
  }
  const sampleCountPerChannel = interleavedPcm.length / blockAlign;
  const tracks = Array.from({ length: channels }, () =>
    Buffer.allocUnsafe(sampleCountPerChannel * 2),
  );
  for (let sample = 0; sample < sampleCountPerChannel; sample++) {
    for (let channel = 0; channel < channels; channel++) {
      tracks[channel]!.writeInt16LE(
        interleavedPcm.readInt16LE((sample * channels + channel) * 2),
        sample * 2,
      );
    }
  }
  return {
    sampleRate,
    channels,
    bitsPerSample: 16,
    sampleCountPerChannel,
    durationMs: round((sampleCountPerChannel / sampleRate) * 1_000),
    interleavedPcm,
    tracks,
  };
}

/** Analyze exact PCM signal properties. RMS dBFS is intentionally not labeled LUFS or MOS. */
export function analyzePcm16Track(
  pcm: Buffer,
  sampleRate: number,
  options: AudioAnalysisOptions = {},
): PcmTrackAnalysis {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) {
    throw new Error(`sampleRate must be a positive integer; got ${sampleRate}`);
  }
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("PCM track must contain complete 16-bit samples");
  }
  const frameMs = options.frameMs ?? DEFAULT_ANALYSIS_FRAME_MS;
  const activityThresholdDbfs = options.activityThresholdDbfs ?? DEFAULT_ACTIVITY_THRESHOLD_DBFS;
  const bridgeSilenceMs = options.bridgeSilenceMs ?? DEFAULT_ACTIVITY_BRIDGE_MS;
  const dropoutMinMs = options.dropoutMinMs ?? DEFAULT_DROPOUT_MIN_MS;
  const dropoutMaxMs = options.dropoutMaxMs ?? DEFAULT_DROPOUT_MAX_MS;
  const clickDeltaFraction = options.clickDeltaFractionOfFullScale ?? 0.5;
  assertPositive("frameMs", frameMs);
  assertNonnegative("bridgeSilenceMs", bridgeSilenceMs);
  assertPositive("dropoutMinMs", dropoutMinMs);
  assertPositive("dropoutMaxMs", dropoutMaxMs);
  if (dropoutMaxMs < dropoutMinMs) {
    throw new Error("dropoutMaxMs must be greater than or equal to dropoutMinMs");
  }
  if (!Number.isFinite(activityThresholdDbfs) || activityThresholdDbfs >= 0) {
    throw new Error("activityThresholdDbfs must be a finite negative number");
  }
  if (!Number.isFinite(clickDeltaFraction) || clickDeltaFraction <= 0 || clickDeltaFraction > 2) {
    throw new Error("clickDeltaFractionOfFullScale must be in (0, 2]");
  }

  const sampleCount = pcm.length / 2;
  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1_000));
  const amplitudeThreshold = 32_768 * 10 ** (activityThresholdDbfs / 20);
  const clickDeltaThreshold = Math.round(32_768 * clickDeltaFraction);
  let peakSample = 0;
  let sum = 0;
  let sumSquares = 0;
  let clippedSampleCount = 0;
  let clickCandidateCount = 0;
  let previous = 0;
  for (let sample = 0; sample < sampleCount; sample++) {
    const value = pcm.readInt16LE(sample * 2);
    const absolute = Math.abs(value);
    peakSample = Math.max(peakSample, absolute);
    sum += value;
    sumSquares += value * value;
    if (value === -32_768 || value === 32_767) clippedSampleCount++;
    if (sample > 0 && Math.abs(value - previous) >= clickDeltaThreshold) clickCandidateCount++;
    previous = value;
  }

  const activeFrames: boolean[] = [];
  const activeFrameRms: number[] = [];
  let activeSumSquares = 0;
  let activeSampleCount = 0;
  for (let start = 0; start < sampleCount; start += frameSamples) {
    const end = Math.min(sampleCount, start + frameSamples);
    const frameSumSquares = sumSquaresInRange(pcm, start, end);
    const rms = Math.sqrt(frameSumSquares / (end - start));
    const active = rms >= amplitudeThreshold;
    activeFrames.push(active);
    if (active) {
      activeFrameRms.push(rms);
      activeSumSquares += frameSumSquares;
      activeSampleCount += end - start;
    }
  }

  const activityRegions = activityRegionsFromFrames(
    activeFrames,
    frameSamples,
    sampleCount,
    sampleRate,
    bridgeSilenceMs,
  );
  const firstRegion = activityRegions.at(0);
  const lastRegion = activityRegions.at(-1);
  const interiorPauses: AudioRegion[] = [];
  for (let index = 1; index < activityRegions.length; index++) {
    interiorPauses.push(
      region(
        activityRegions[index - 1]!.endSample,
        activityRegions[index]!.startSample,
        sampleRate,
      ),
    );
  }
  const dropoutCandidates = findDigitalZeroDropoutCandidates(
    pcm,
    sampleRate,
    frameSamples,
    amplitudeThreshold,
    dropoutMinMs,
    dropoutMaxMs,
  );

  const overallRms = Math.sqrt(sumSquares / sampleCount);
  const activeRms = activeSampleCount > 0 ? Math.sqrt(activeSumSquares / activeSampleCount) : null;
  const activeDurationMs = (activeSampleCount / sampleRate) * 1_000;
  const sortedActiveDbfs = activeFrameRms
    .map((value) => dbfs(value))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  return {
    sampleRate,
    sampleCount,
    durationMs: round((sampleCount / sampleRate) * 1_000),
    frameMs: round((frameSamples / sampleRate) * 1_000),
    frameSamples,
    activityThresholdDbfs,
    peakSample,
    peakDbfs: dbfs(peakSample),
    overallRmsDbfs: dbfs(overallRms),
    activeRmsDbfs: activeRms === null ? null : dbfs(activeRms),
    activeFrameRmsDbfs: {
      p10: percentile(sortedActiveDbfs, 0.1),
      p50: percentile(sortedActiveDbfs, 0.5),
      p95: percentile(sortedActiveDbfs, 0.95),
    },
    crestFactorDb:
      activeRms === null || peakSample === 0
        ? null
        : round(20 * Math.log10(peakSample / activeRms)),
    dcOffset: round(sum / sampleCount),
    clippedSampleCount,
    clippedSampleRatio: round(clippedSampleCount / sampleCount, 9),
    clickDeltaThreshold,
    clickCandidateCount,
    frameCount: activeFrames.length,
    activeFrameCount: activeFrames.filter(Boolean).length,
    silentFrameCount: activeFrames.filter((active) => !active).length,
    activeDurationMs: round(activeDurationMs),
    activeTimelineRatio: round(activeSampleCount / sampleCount, 6),
    leadingSilenceMs: round(((firstRegion?.startSample ?? sampleCount) / sampleRate) * 1_000),
    trailingSilenceMs: round(((sampleCount - (lastRegion?.endSample ?? 0)) / sampleRate) * 1_000),
    activityRegions,
    interiorPauses,
    dropoutHeuristic: {
      description:
        "Exact digital-zero run bounded on both sides by an active analysis frame; candidates can also be natural pauses and are not proof of transport loss.",
      minimumMs: dropoutMinMs,
      maximumMs: dropoutMaxMs,
      candidateCount: dropoutCandidates.length,
      totalCandidateMs: round(
        dropoutCandidates.reduce((total, candidate) => total + candidate.durationMs, 0),
      ),
      longestCandidateMs: round(
        Math.max(0, ...dropoutCandidates.map((candidate) => candidate.durationMs)),
      ),
      candidates: dropoutCandidates,
    },
  };
}

export function analyzeDuplexActivity(
  inputPcm: Buffer,
  outputPcm: Buffer,
  sampleRate: number,
  activityThresholdDbfs = DEFAULT_ACTIVITY_THRESHOLD_DBFS,
  resolutionMs = 1,
): DuplexActivityAnalysis {
  if (inputPcm.length % 2 !== 0 || outputPcm.length % 2 !== 0) {
    throw new Error("duplex tracks must contain complete 16-bit samples");
  }
  assertPositive("resolutionMs", resolutionMs);
  const sampleCount = Math.max(inputPcm.length, outputPcm.length) / 2;
  const resolutionSamples = Math.max(1, Math.round((sampleRate * resolutionMs) / 1_000));
  const threshold = 32_768 * 10 ** (activityThresholdDbfs / 20);
  let inputOnlySamples = 0;
  let outputOnlySamples = 0;
  let simultaneousSamples = 0;
  let neitherSamples = 0;
  let windowCount = 0;
  for (let start = 0; start < sampleCount; start += resolutionSamples) {
    const end = Math.min(sampleCount, start + resolutionSamples);
    const inputActive = rmsInPaddedRange(inputPcm, start, end) >= threshold;
    const outputActive = rmsInPaddedRange(outputPcm, start, end) >= threshold;
    const samples = end - start;
    windowCount++;
    if (inputActive && outputActive) simultaneousSamples += samples;
    else if (inputActive) inputOnlySamples += samples;
    else if (outputActive) outputOnlySamples += samples;
    else neitherSamples += samples;
  }
  const inputActivity = inputOnlySamples + simultaneousSamples;
  const outputActivity = outputOnlySamples + simultaneousSamples;
  return {
    resolutionMs: round((resolutionSamples / sampleRate) * 1_000),
    resolutionSamples,
    windowCount,
    inputOnlyMs: samplesToMs(inputOnlySamples, sampleRate),
    outputOnlyMs: samplesToMs(outputOnlySamples, sampleRate),
    simultaneousAudibleMs: samplesToMs(simultaneousSamples, sampleRate),
    neitherAudibleMs: samplesToMs(neitherSamples, sampleRate),
    simultaneousShareOfInputActivity: round(
      inputActivity === 0 ? 0 : simultaneousSamples / inputActivity,
      6,
    ),
    simultaneousShareOfOutputActivity: round(
      outputActivity === 0 ? 0 : simultaneousSamples / outputActivity,
      6,
    ),
  };
}

export function analyzePcm16Wav(wav: Buffer, options: AudioAnalysisOptions = {}): WavAudioAnalysis {
  const parsed = parsePcm16Wav(wav);
  return {
    schemaVersion: AUDIO_ANALYSIS_SCHEMA_VERSION,
    sha256: createHash("sha256").update(wav).digest("hex"),
    format: {
      codec: "pcm_s16le",
      sampleRate: parsed.sampleRate,
      channels: parsed.channels,
      bitsPerSample: parsed.bitsPerSample,
      sampleCountPerChannel: parsed.sampleCountPerChannel,
      durationMs: parsed.durationMs,
    },
    tracks: parsed.tracks.map((track) => analyzePcm16Track(track, parsed.sampleRate, options)),
    duplex:
      parsed.channels === 2
        ? analyzeDuplexActivity(
            parsed.tracks[0]!,
            parsed.tracks[1]!,
            parsed.sampleRate,
            options.activityThresholdDbfs,
          )
        : null,
  };
}

export async function analyzePcm16WavFile(
  path: string,
  options: AudioAnalysisOptions = {},
): Promise<WavAudioAnalysis> {
  if (!(await Bun.file(path).exists())) throw new Error(`audio file does not exist: ${path}`);
  return analyzePcm16Wav(Buffer.from(await Bun.file(path).arrayBuffer()), options);
}

/**
 * Deterministic semantic windows for a blind listening judge. The two full-length sources remain
 * primary evidence; steering and final-exchange windows make the most diagnostic moments cheap to
 * replay without deleting silence that carries latency information.
 */
export function planBlindAudioClips(
  events: TimedAudioEvent[],
  artifactDurationMs: number,
  sampleRate = 48_000,
): BlindAudioClipPlan {
  assertPositive("artifactDurationMs", artifactDurationMs);
  assertPositive("sampleRate", sampleRate);
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  for (const event of ordered) {
    if (!Number.isInteger(event.seq) || !Number.isFinite(event.atMs) || event.atMs < 0) {
      throw new Error("audio events require an integer seq and a finite, nonnegative atMs");
    }
  }
  const inputs = ordered.filter(
    (event) => event.source === "media" && event.type === "input.audio.started",
  );
  const steer = inputs.find((event) => event.data.id === "steer");
  const verify = inputs.find((event) => event.data.id === "verify");
  if (!steer) throw new Error("cannot plan steering clip without input.audio.started id=steer");
  if (!verify) throw new Error("cannot plan final clip without input.audio.started id=verify");
  const steeringDelegation = ordered.find(
    (event) =>
      event.seq > steer.seq && event.source === "realtime" && event.type === "delegation.created",
  );
  if (!steeringDelegation) {
    throw new Error("cannot plan steering clip without a subsequent native delegation");
  }
  const timelineAlignment = inferJournalToAudioAlignment(ordered, sampleRate);
  const audioTime = (event: TimedAudioEvent) =>
    event.atMs - timelineAlignment.journalToAudioOffsetMs;
  const steeringStartMs = clamp(audioTime(steer) - 1_000, 0, artifactDurationMs);
  const steeringEndMs = clamp(
    Math.max(audioTime(steer) + 2_000, audioTime(steeringDelegation) + 8_000),
    steeringStartMs,
    artifactDurationMs,
  );
  const finalStartMs = clamp(audioTime(verify) - 500, 0, artifactDurationMs);
  return {
    schemaVersion: 1,
    artifactDurationMs: round(artifactDurationMs),
    timelineAlignment,
    clips: [
      clip(
        "output-quality",
        "output.wav",
        "Unmixed agent channel for naturalness, intelligibility, prosody, artifacts, and truncation.",
        0,
        artifactDurationMs,
      ),
      clip(
        "conversation-timing",
        "comparison.wav",
        "Full stereo conversation (evaluator left, agent right), preserving latency and silence.",
        0,
        artifactDurationMs,
      ),
      clip(
        "steering-interaction",
        "comparison.wav",
        "One second before barge-in through eight seconds after its correlated delegation.",
        steeringStartMs,
        steeringEndMs,
      ),
      clip(
        "final-exchange",
        "comparison.wav",
        "Final evaluator request through the end, preserving verification latency and report delivery.",
        finalStartMs,
        artifactDurationMs,
      ),
    ],
  };
}

function inferJournalToAudioAlignment(
  events: TimedAudioEvent[],
  sampleRate: number,
): BlindAudioClipPlan["timelineAlignment"] {
  const sampleAnchors = events.flatMap((event) => {
    if (event.source !== "media" || event.type !== "input.audio.started") return [];
    const startSample = event.data.startSample;
    if (typeof startSample !== "number" || !Number.isInteger(startSample) || startSample < 0) {
      return [];
    }
    return [event.atMs - (startSample / sampleRate) * 1_000];
  });
  if (sampleAnchors.length > 0) {
    sampleAnchors.sort((left, right) => left - right);
    const middle = Math.floor(sampleAnchors.length / 2);
    const median =
      sampleAnchors.length % 2 === 1
        ? sampleAnchors[middle]!
        : (sampleAnchors[middle - 1]! + sampleAnchors[middle]!) / 2;
    return { journalToAudioOffsetMs: round(median), source: "input-start-samples" };
  }
  const peerConnecting = events.find(
    (event) => event.source === "media" && event.type === "peer.connecting",
  );
  if (peerConnecting) {
    return {
      journalToAudioOffsetMs: round(peerConnecting.atMs),
      source: "media.peer.connecting",
    };
  }
  return { journalToAudioOffsetMs: 0, source: "assumed-zero" };
}

function activityRegionsFromFrames(
  activeFrames: boolean[],
  frameSamples: number,
  sampleCount: number,
  sampleRate: number,
  bridgeSilenceMs: number,
): AudioRegion[] {
  const raw: Array<{ start: number; end: number }> = [];
  let startFrame: number | null = null;
  for (let frame = 0; frame <= activeFrames.length; frame++) {
    const active = activeFrames[frame] ?? false;
    if (active && startFrame === null) startFrame = frame;
    if (!active && startFrame !== null) {
      raw.push({
        start: startFrame * frameSamples,
        end: Math.min(sampleCount, frame * frameSamples),
      });
      startFrame = null;
    }
  }
  const bridgeSamples = Math.round((sampleRate * bridgeSilenceMs) / 1_000);
  const merged: Array<{ start: number; end: number }> = [];
  for (const current of raw) {
    const previous = merged.at(-1);
    if (previous && current.start - previous.end <= bridgeSamples) previous.end = current.end;
    else merged.push({ ...current });
  }
  return merged.map(({ start, end }) => region(start, end, sampleRate));
}

function findDigitalZeroDropoutCandidates(
  pcm: Buffer,
  sampleRate: number,
  frameSamples: number,
  activityThreshold: number,
  minimumMs: number,
  maximumMs: number,
): AudioRegion[] {
  const sampleCount = pcm.length / 2;
  const minimumSamples = Math.ceil((sampleRate * minimumMs) / 1_000);
  const maximumSamples = Math.floor((sampleRate * maximumMs) / 1_000);
  const candidates: AudioRegion[] = [];
  let sample = 0;
  while (sample < sampleCount) {
    if (pcm.readInt16LE(sample * 2) !== 0) {
      sample++;
      continue;
    }
    const start = sample;
    while (sample < sampleCount && pcm.readInt16LE(sample * 2) === 0) sample++;
    const end = sample;
    const length = end - start;
    if (
      length >= minimumSamples &&
      length <= maximumSamples &&
      start >= frameSamples &&
      end + frameSamples <= sampleCount &&
      rmsInPaddedRange(pcm, start - frameSamples, start) >= activityThreshold &&
      rmsInPaddedRange(pcm, end, end + frameSamples) >= activityThreshold
    ) {
      candidates.push(region(start, end, sampleRate));
    }
  }
  return candidates;
}

function sumSquaresInRange(pcm: Buffer, startSample: number, endSample: number): number {
  let sumSquares = 0;
  for (let sample = startSample; sample < endSample; sample++) {
    const value = pcm.readInt16LE(sample * 2);
    sumSquares += value * value;
  }
  return sumSquares;
}

function rmsInPaddedRange(pcm: Buffer, startSample: number, endSample: number): number {
  let sumSquares = 0;
  for (let sample = startSample; sample < endSample; sample++) {
    const byteOffset = sample * 2;
    const value = byteOffset >= 0 && byteOffset + 1 < pcm.length ? pcm.readInt16LE(byteOffset) : 0;
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / Math.max(1, endSample - startSample));
}

function dbfs(amplitude: number): number | null {
  return amplitude <= 0 ? null : round(20 * Math.log10(amplitude / 32_768));
}

function percentile(sorted: number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const fraction = index - lower;
  const value =
    sorted[lower]! + (sorted[Math.min(sorted.length - 1, lower + 1)]! - sorted[lower]!) * fraction;
  return round(value);
}

function region(startSample: number, endSample: number, sampleRate: number): AudioRegion {
  return {
    startSample,
    endSample,
    startMs: samplesToMs(startSample, sampleRate),
    endMs: samplesToMs(endSample, sampleRate),
    durationMs: samplesToMs(endSample - startSample, sampleRate),
  };
}

function clip(
  id: BlindAudioClip["id"],
  source: BlindAudioClip["source"],
  purpose: string,
  startMs: number,
  endMs: number,
): BlindAudioClip {
  return {
    id,
    source,
    purpose,
    startMs: round(startMs),
    endMs: round(endMs),
    durationMs: round(endMs - startMs),
  };
}

function samplesToMs(samples: number, sampleRate: number): number {
  return round((samples / sampleRate) * 1_000);
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function assertNonnegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be nonnegative`);
}
