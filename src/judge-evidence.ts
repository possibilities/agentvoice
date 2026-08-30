import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { z } from "zod";
import { JUDGE_RUBRIC, JUDGE_RUBRIC_VERSION } from "./judge-rubric.ts";

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_EVENTS_BYTES = 8_000_000;
const MAX_ORACLE_BYTES = 1_000_000;
const MAX_PATCH_BYTES = 1_000_000;
const MAX_EVIDENCE_CONTENT = 32_000;

const manifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    contender: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    failure: z.string().nullable().optional(),
    scenario: z.object({
      id: z.string().min(1),
      description: z.string().min(1),
    }),
    runtime: z
      .object({
        audioDurationMs: z.number().nonnegative().nullable().optional(),
      })
      .passthrough()
      .optional(),
    validation: z.unknown().nullable().optional(),
    quality: z
      .object({
        workspaceScore: z.number().min(0).max(1).nullable().optional(),
        workspacePassed: z.boolean().nullable().optional(),
      })
      .passthrough()
      .optional(),
    evidence: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const eventSchema = z
  .object({
    seq: z.number().int().positive(),
    atMs: z.number().nonnegative(),
    source: z.string().min(1),
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const oracleSchema = z
  .object({
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    valid: z.boolean(),
    validationError: z.string().nullable(),
    score: z.number().min(0).max(1).nullable(),
    parsed: z.unknown(),
  })
  .passthrough();

export const evidenceItemSchema = z
  .object({
    id: z.string().min(1).max(160),
    source: z.enum(["manifest", "event", "oracle", "workspace_patch", "derived"]),
    locator: z.string().min(1).max(240),
    atMs: z.number().nonnegative().nullable(),
    content: z.string().min(1).max(MAX_EVIDENCE_CONTENT),
  })
  .strict();

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const deterministicHarnessSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    completed: z.boolean(),
    failure: z.string().nullable(),
    traceValidation: z.enum(["passed", "not_passed"]),
    traceValidationDetails: z.record(z.string(), z.unknown()).nullable(),
    workspaceOracle: z
      .object({
        passed: z.boolean(),
        score: z.number().min(0).max(1).nullable(),
      })
      .nullable(),
  })
  .strict();

export type DeterministicHarness = z.infer<typeof deterministicHarnessSchema>;

export interface LoadedJudgeEvidence {
  artifactDirectory: string;
  artifactId: string;
  manifestSha256: string;
  contender: string;
  scenarioId: string;
  scenarioDescription: string;
  deterministicHarness: DeterministicHarness;
  catalog: EvidenceItem[];
  modelInput: Record<string, unknown>;
  evidenceSha256: string;
}

export interface LoadJudgeEvidenceOptions {
  /** Secret values that must be removed in addition to generic key patterns. */
  secrets?: readonly string[];
}

/**
 * Builds a compact, allowlisted evidence catalog. Raw App-server/realtime
 * payloads and stderr never enter the judge request.
 */
export function loadJudgeEvidence(
  artifactDirectory: string,
  options: LoadJudgeEvidenceOptions = {},
): LoadedJudgeEvidence {
  const artifact = realpathSync(resolve(artifactDirectory));
  const manifestPath = resolveArtifactFile(artifact, "manifest.json", true)!;
  const manifestBytes = readBoundedFile(manifestPath, MAX_MANIFEST_BYTES, "manifest");
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const secrets = options.secrets ?? [];
  const catalog: EvidenceItem[] = [];
  const evidenceIds = new Set<string>();
  const add = (item: EvidenceItem): void => {
    const parsed = evidenceItemSchema.parse({
      ...item,
      content: truncate(redactSecrets(item.content, secrets), MAX_EVIDENCE_CONTENT),
    });
    if (evidenceIds.has(parsed.id)) throw new Error(`duplicate judge evidence ID ${parsed.id}`);
    evidenceIds.add(parsed.id);
    catalog.push(parsed);
  };

  const deterministicHarness = deterministicHarnessSchema.parse({
    status: manifest.status,
    completed: manifest.status === "completed",
    failure: manifest.failure ? redactSecrets(manifest.failure, secrets) : null,
    traceValidation:
      manifest.validation === null || manifest.validation === undefined ? "not_passed" : "passed",
    traceValidationDetails:
      manifest.validation === null || manifest.validation === undefined
        ? null
        : primitiveSummary(manifest.validation, secrets),
    workspaceOracle:
      typeof manifest.quality?.workspacePassed === "boolean"
        ? {
            passed: manifest.quality.workspacePassed,
            score: manifest.quality.workspaceScore ?? null,
          }
        : null,
  });

  add({
    id: "manifest:run-state",
    source: "manifest",
    locator: "manifest.json#status",
    atMs: null,
    content: JSON.stringify(deterministicHarness),
  });
  add({
    id: "manifest:scenario",
    source: "manifest",
    locator: "manifest.json#scenario",
    atMs: null,
    content: JSON.stringify({
      id: redactSecrets(manifest.scenario.id, secrets),
      description: redactSecrets(manifest.scenario.description, secrets),
    }),
  });

  const eventsPath = evidenceFile(manifest.evidence, "events", artifact, true)!;
  const events = parseEvents(readBoundedFile(eventsPath, MAX_EVENTS_BYTES, "event trace"));
  addCanonicalEvents(events, add, secrets);
  addInteractionSummary(events, manifest.runtime?.audioDurationMs ?? null, add, secrets);

  const oraclePath = evidenceFile(manifest.evidence, "oracle", artifact, false);
  if (oraclePath) addOracleEvidence(oraclePath, add, secrets);

  const patchPath = evidenceFile(manifest.evidence, "workspacePatch", artifact, false);
  if (patchPath) addPatchEvidence(patchPath, artifact, add, secrets);

  addAudioArtifactEvidence(manifest.evidence, artifact, add);

  const modelInput = {
    rubricVersion: JUDGE_RUBRIC_VERSION,
    scoreScale: {
      0: "failed or absent",
      1: "major deficiencies",
      2: "partial or mixed",
      3: "strong with minor deficiencies",
      4: "exemplary",
    },
    scenario: {
      id: redactSecrets(manifest.scenario.id, secrets),
      description: redactSecrets(manifest.scenario.description, secrets),
    },
    deterministicHarness,
    rubric: JUDGE_RUBRIC,
    evidenceCatalog: catalog,
    observationBoundary: {
      audioBytesProvidedToJudge: false,
      note: "Audio artifact presence is recorded, but audio bytes are not provided. Vocal delivery must be not_observable and must not affect the aggregate score.",
    },
  };
  const serializedInput = JSON.stringify(modelInput);

  return {
    artifactDirectory: artifact,
    artifactId: redactSecrets(basename(artifact), secrets),
    manifestSha256: sha256(manifestBytes),
    contender: redactSecrets(manifest.contender, secrets),
    scenarioId: redactSecrets(manifest.scenario.id, secrets),
    scenarioDescription: redactSecrets(manifest.scenario.description, secrets),
    deterministicHarness,
    catalog,
    modelInput,
    evidenceSha256: sha256(Buffer.from(serializedInput)),
  };
}

export function redactSecrets(text: string, explicitSecrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of explicitSecrets) {
    if (secret.length >= 6) redacted = redacted.split(secret).join("[REDACTED_SECRET]");
  }
  redacted = redacted
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/(API key (?:provided|received)\s*:\s*)[^\s,.}]+/gi, "$1[REDACTED_SECRET]")
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b(\s*[=:]\s*)["']?[^\s"',;}]+/gi,
      (_match, label: string, separator: string) => `${label}${separator}[REDACTED_SECRET]`,
    );
  return redacted;
}

function addCanonicalEvents(
  events: readonly z.infer<typeof eventSchema>[],
  add: (item: EvidenceItem) => void,
  secrets: readonly string[],
): void {
  let rootTurnStarted = 0;
  let rootTurnCompleted = 0;
  for (const event of events) {
    let content: string | null = null;
    switch (event.type) {
      case "fixture.utterance":
        content = JSON.stringify({
          kind: "scripted_evaluator_utterance",
          id: identifierValue(event.data["id"], secrets),
          transcript: textValue(event.data["transcript"], secrets),
        });
        break;
      case "input.transcript.done":
        content = JSON.stringify({
          kind: "observed_evaluator_transcript",
          transcript: textValue(event.data["text"], secrets),
        });
        break;
      case "output.transcript.done":
        content = JSON.stringify({
          kind: "agent_spoken_transcript",
          transcript: textValue(event.data["text"], secrets),
        });
        break;
      case "delegation.created":
        content = JSON.stringify({
          kind: "delegation_to_orchestrator",
          text: textValue(event.data["text"], secrets),
        });
        break;
      case "input.audio.started":
        content = JSON.stringify({
          kind: "evaluator_audio_started",
          id: identifierValue(event.data["id"], secrets),
          durationMs: numberValue(event.data["durationMs"]),
        });
        break;
      case "input.audio.finished":
        content = JSON.stringify({
          kind: "evaluator_audio_finished",
          id: identifierValue(event.data["id"], secrets),
        });
        break;
      case "output.audio.started":
        content = JSON.stringify({ kind: "decoded_agent_speech_started" });
        break;
      case "output.audio.finished":
      case "output.audio.stopped":
      case "output.audio.idle":
        content = JSON.stringify({ kind: "decoded_agent_speech_inactive", event: event.type });
        break;
      case "orchestrator.turn.started":
        rootTurnStarted++;
        content = JSON.stringify({
          kind: "root_orchestrator_turn_started",
          occurrence: rootTurnStarted,
          status: identifierValue(event.data["status"], secrets),
        });
        break;
      case "orchestrator.turn.completed":
        rootTurnCompleted++;
        content = JSON.stringify({
          kind: "root_orchestrator_turn_completed",
          occurrence: rootTurnCompleted,
          status: identifierValue(event.data["status"], secrets),
          error: textValue(event.data["error"], secrets),
        });
        break;
    }
    if (!content) continue;
    add({
      id: `event:${event.seq}`,
      source: "event",
      locator: `events.ndjson#seq=${event.seq}`,
      atMs: round(event.atMs, 1),
      content,
    });
  }
}

function addInteractionSummary(
  events: readonly z.infer<typeof eventSchema>[],
  audioDurationMs: number | null,
  add: (item: EvidenceItem) => void,
  secrets: readonly string[],
): void {
  const starts = events.filter((event) => event.type === "input.audio.started");
  const delegations = events.filter((event) => event.type === "delegation.created");
  const latencies = starts.map((start, index) => {
    const id = identifierValue(start.data["id"], secrets);
    const nextStart = starts[index + 1];
    const finish = events.find(
      (event) =>
        event.seq > start.seq &&
        event.type === "input.audio.finished" &&
        identifierValue(event.data["id"], secrets) === id,
    );
    const delegation = delegations.find(
      (event) =>
        event.seq > (finish?.seq ?? start.seq) &&
        (nextStart === undefined || event.seq < nextStart.seq),
    );
    return {
      utteranceId: id,
      endToDelegationMs: finish && delegation ? round(delegation.atMs - finish.atMs, 1) : null,
    };
  });
  const outputTranscripts = events.filter((event) => event.type === "output.transcript.done");
  const inputTranscripts = events.filter((event) => event.type === "input.transcript.done");
  const rootStarts = events.filter((event) => event.type === "orchestrator.turn.started");
  const rootCompletions = events.filter((event) => event.type === "orchestrator.turn.completed");

  add({
    id: "derived:interaction-summary",
    source: "derived",
    locator: "events.ndjson#derived-interaction-summary",
    atMs: null,
    content: JSON.stringify({
      runAudioDurationMs: audioDurationMs === null ? null : round(audioDurationMs, 1),
      evaluatorUtterances: starts.length,
      observedInputTranscripts: inputTranscripts.length,
      delegations: delegations.length,
      spokenResponses: outputTranscripts.length,
      rootOrchestratorTurnStarts: rootStarts.length,
      rootOrchestratorTurnCompletions: rootCompletions.length,
      utteranceEndToDelegationLatency: latencies,
    }),
  });
}

function addOracleEvidence(
  path: string,
  add: (item: EvidenceItem) => void,
  secrets: readonly string[],
): void {
  const bytes = readBoundedFile(path, MAX_ORACLE_BYTES, "oracle evidence");
  const oracle = oracleSchema.parse(JSON.parse(bytes.toString("utf8")));
  add({
    id: "oracle:summary",
    source: "oracle",
    locator: "oracle.json",
    atMs: null,
    content: JSON.stringify({
      exitCode: oracle.exitCode,
      durationMs: round(oracle.durationMs, 1),
      valid: oracle.valid,
      validationError: oracle.validationError
        ? redactSecrets(oracle.validationError, secrets)
        : null,
      score: oracle.score,
    }),
  });

  if (!isRecord(oracle.parsed) || !Array.isArray(oracle.parsed["checks"])) return;
  for (const [index, value] of oracle.parsed["checks"].entries()) {
    if (!isRecord(value)) continue;
    add({
      id: `oracle:check:${index + 1}`,
      source: "oracle",
      locator: `oracle.json#parsed.checks[${index}]`,
      atMs: null,
      content: JSON.stringify({
        name: textValue(value["name"], secrets),
        passed: typeof value["passed"] === "boolean" ? value["passed"] : null,
        detail: truncate(textValue(value["detail"], secrets) ?? "", 4_000),
      }),
    });
  }
}

function addPatchEvidence(
  path: string,
  artifactDirectory: string,
  add: (item: EvidenceItem) => void,
  secrets: readonly string[],
): void {
  const bytes = readBoundedFile(path, MAX_PATCH_BYTES, "workspace patch");
  const raw = bytes.toString("utf8").split(artifactDirectory).join("[ARTIFACT]");
  const redacted = redactSecrets(raw, secrets);
  const content = truncate(redacted, MAX_EVIDENCE_CONTENT);
  add({
    id: "workspace-patch:1",
    source: "workspace_patch",
    locator: "workspace.patch",
    atMs: null,
    content:
      content +
      (content.length < redacted.length
        ? `\n[TRUNCATED ${redacted.length - content.length} CHARACTERS]`
        : ""),
  });
}

function addAudioArtifactEvidence(
  evidence: Record<string, unknown>,
  artifactDirectory: string,
  add: (item: EvidenceItem) => void,
): void {
  const names = ["inputAudio", "outputAudio", "comparisonAudio"] as const;
  const files = names.map((name) => {
    const path = evidenceFile(evidence, name, artifactDirectory, false);
    return {
      kind: name,
      present: path !== null,
      bytes: path ? statSync(path).size : null,
      inspectedByJudge: false,
    };
  });
  add({
    id: "manifest:audio-artifacts",
    source: "manifest",
    locator: "manifest.json#evidence",
    atMs: null,
    content: JSON.stringify(files),
  });
}

function parseEvents(bytes: Buffer): z.infer<typeof eventSchema>[] {
  const events: z.infer<typeof eventSchema>[] = [];
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(eventSchema.parse(JSON.parse(line)));
    } catch (error) {
      throw new Error(
        `invalid event trace line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events.sort((left, right) => left.seq - right.seq);
}

function evidenceFile(
  evidence: Record<string, unknown>,
  key: string,
  artifactDirectory: string,
  required: boolean,
): string | null {
  const value = evidence[key];
  if (value === null || value === undefined) {
    if (required) throw new Error(`manifest evidence.${key} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`manifest evidence.${key} must be a non-empty relative path or null`);
  }
  return resolveArtifactFile(artifactDirectory, value, required);
}

function resolveArtifactFile(
  artifactDirectory: string,
  relativePath: string,
  required: boolean,
): string | null {
  const candidate = resolve(artifactDirectory, relativePath);
  const prefix = artifactDirectory.endsWith(sep) ? artifactDirectory : `${artifactDirectory}${sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`artifact evidence path escapes its directory: ${relativePath}`);
  }
  if (!existsSync(candidate)) {
    if (required) throw new Error(`artifact evidence file is missing: ${relativePath}`);
    return null;
  }
  const real = realpathSync(candidate);
  if (!real.startsWith(prefix)) {
    throw new Error(`artifact evidence symlink escapes its directory: ${relativePath}`);
  }
  if (!statSync(real).isFile()) throw new Error(`artifact evidence is not a file: ${relativePath}`);
  return real;
}

function readBoundedFile(path: string, maximumBytes: number, label: string): Buffer {
  const size = statSync(path).size;
  if (size > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes; got ${size}`);
  }
  return readFileSync(path);
}

function primitiveSummary(value: unknown, secrets: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return { value: redactSecrets(String(value), secrets) };
  const summary: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/id$/i.test(key) || /ids$/i.test(key)) continue;
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "number" ||
      typeof item === "string"
    ) {
      summary[key] =
        typeof item === "string" ? truncate(redactSecrets(item, secrets), 1_000) : item;
    }
  }
  return summary;
}

function textValue(value: unknown, secrets: readonly string[]): string | null {
  if (value === null || value === undefined) return null;
  return truncate(redactSecrets(String(value), secrets), 8_000);
}

function identifierValue(value: unknown, secrets: readonly string[]): string | null {
  return typeof value === "string" ? truncate(redactSecrets(value, secrets), 200) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
