/**
 * The two app-server payloads that prime the agents, built as pure functions so
 * the mapping from config and prompt files to wire fields is testable: a wrong
 * field name here is silently ignored upstream rather than rejected.
 *
 * Unset options are never sent, preserving native defaults/configuration. A prompt
 * that resolved to the empty string IS sent — empty strips a built-in prompt,
 * where absent leaves codex's default in place.
 */
import type { Prompts, ServerConfig } from "./config.ts";
import { ConfigError, VOICE_SEEDS } from "./config.ts";
import { validateFullAccessParams } from "./full-access.ts";

export const ORCHESTRATOR_THREAD_SOURCE = "agentvoice-orchestrator";

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Orchestrator-agent priming. `thread/resume` accepts a subset — it ignores
 * unknown fields rather than failing, but sending start-only ones would be a
 * lie about what resuming applies.
 */
export function threadParams(
  config: ServerConfig,
  prompts: Prompts,
  kind: "start" | "resume",
): Record<string, unknown> {
  const orchestrator = config.orchestrator;
  const params: Record<string, unknown> = {
    cwd: orchestrator.workspace,
    approvalPolicy: orchestrator.approvalPolicy,
  };
  // Upstream rejects the pair; resolveConfig rejects setting both.
  if (orchestrator.permissions !== undefined) params["permissions"] = orchestrator.permissions;
  else params["sandbox"] = orchestrator.sandbox;

  setIfDefined(params, "model", orchestrator.model);
  setIfDefined(params, "modelProvider", orchestrator.modelProvider);
  setIfDefined(params, "serviceTier", orchestrator.serviceTier);
  setIfDefined(params, "personality", orchestrator.personality);
  setIfDefined(params, "approvalsReviewer", orchestrator.approvalsReviewer);
  setIfDefined(params, "runtimeWorkspaceRoots", orchestrator.runtimeWorkspaceRoots);
  setIfDefined(params, "baseInstructions", prompts.orchestratorBaseInstructions);
  setIfDefined(params, "developerInstructions", prompts.orchestratorDeveloperInstructions);

  // `effort` is shorthand for a config entry, so an explicit entry wins.
  const codexConfig = {
    ...(orchestrator.effort ? { model_reasoning_effort: orchestrator.effort } : {}),
    ...orchestrator.config,
  };
  if (Object.keys(codexConfig).length > 0) params["config"] = codexConfig;

  if (kind === "start") {
    setIfDefined(params, "ephemeral", orchestrator.ephemeral);
    setIfDefined(params, "historyMode", orchestrator.historyMode);
  }
  const merged: Record<string, unknown> = {
    ...params,
    ...orchestrator.extra,
    cwd: orchestrator.workspace,
  };
  // Thread identity is owned by AgentVoice, not the generic extra escape
  // hatch: inventory must remain reliable under every configuration.
  if (kind === "start") merged["threadSource"] = ORCHESTRATOR_THREAD_SOURCE;
  validateFullAccessParams(merged);
  // A raw matching built-in profile is allowed, but Codex rejects both selectors.
  if (merged["permissions"] !== undefined) delete merged["sandbox"];
  return merged;
}

/**
 * Voice-agent priming, plus the orchestrator's session-boundary instructions:
 * those ride on this call but are developer messages to the other agent.
 */
export function realtimeParams(
  config: ServerConfig,
  prompts: Prompts,
  threadId: string,
  realtimeSessionId: string,
  sdp: string,
): Record<string, unknown> {
  const voice = config.voice;
  const params: Record<string, unknown> = {
    threadId,
    realtimeSessionId,
    outputModality: "audio",
    transport: { type: "webrtc", sdp },
  };
  setIfDefined(params, "version", voice.version);
  setIfDefined(params, "model", voice.model);
  setIfDefined(params, "voice", voice.name);
  setIfDefined(params, "prompt", prompts.voicePrompt);
  setIfDefined(params, "realtimeStartInstructions", prompts.orchestratorSessionStart);
  setIfDefined(params, "realtimeEndInstructions", prompts.orchestratorSessionEnd);

  const initialItems = VOICE_SEEDS.flatMap(([name, role]) => {
    const text = prompts[name];
    return text === undefined ? [] : [{ role, text }];
  });
  if (initialItems.length > 0) params["initialItems"] = initialItems;

  setIfDefined(params, "includeStartupContext", voice.includeStartupContext);
  setIfDefined(params, "delegationAckFiller", voice.delegationAckFiller);
  setIfDefined(params, "codexResponseHandoffMode", voice.codexResponseHandoffMode);
  setIfDefined(params, "codexResponsesAsItems", voice.codexResponsesAsItems);
  setIfDefined(params, "codexResponseItemPrefix", voice.codexResponseItemPrefix);
  setIfDefined(
    params,
    "codexResponseHandoffChannelPrefixes",
    voice.codexResponseHandoffChannelPrefixes,
  );
  setIfDefined(params, "flushTranscriptTailOnSessionEnd", voice.flushTranscriptTailOnSessionEnd);
  setIfDefined(params, "clientManagedHandoffs", voice.clientManagedHandoffs);

  const merged = { ...params, ...voice.extra };
  const version = merged["version"];
  const transport = merged["transport"] as { type?: string } | null;
  if (transport?.type === "webrtc" && version === "v2")
    throw new ConfigError(
      "Realtime v2 is not supported by Codex's WebRTC transport; omit voice.version for the native default or explicitly select v1/v3 (also check voice.extra.version).",
    );
  const items = merged["initialItems"];
  if (Array.isArray(items) && items.length > 0 && version !== "v3")
    throw new ConfigError(
      'Initial voice items (VOICE_SEED_*.md or voice.extra.initialItems) require explicit realtime v3. Set voice.version to "v3" (and check voice.extra.version), or remove the seeds. AgentVoice will not discard them or choose a protocol for you.',
    );
  return merged;
}
