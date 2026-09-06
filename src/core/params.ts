/**
 * The two app-server payloads that prime the agents, built as pure functions so
 * the mapping from config and prompt files to wire fields is testable: a wrong
 * field name here is silently ignored upstream rather than rejected.
 *
 * Unset options stay omitted except documented application defaults. A prompt
 * that resolved to the empty string IS sent — empty strips a built-in prompt,
 * where absent leaves codex's default in place.
 */
import type { Prompts, ServerConfig } from "./config.ts";
import { ConfigError, PROMPT_FILES, STARTUP_CONTEXT_KEY } from "./config.ts";
import { DEFAULT_WEBRTC_VERSION } from "./config-schema.ts";
import { applyFullAccessOptIn } from "./full-access.ts";
import { ROLE_MCP_FILE, type RoleAssets } from "./role.ts";

export const ORCHESTRATOR_THREAD_SOURCE = "agentvoice-orchestrator";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendSlotConflict(setting: string): ConfigError {
  return new ConfigError(
    `${PROMPT_FILES.voiceAppend} uses Codex's startup-context slot; remove ${setting} or the file`,
  );
}

// Codex 0.153.3 ThreadStartParams fields absent from ThreadResumeParams.
// Filter after raw extra merges; unknown future fields remain passthrough.
const START_ONLY_FIELDS = [
  "allowProviderModelFallback",
  "serviceName",
  "multiAgentMode",
  "ephemeral",
  "historyMode",
  "sessionStartSource",
  "threadSource",
  "projectId",
  "environments",
  "dynamicTools",
  "selectedCapabilityRoots",
  "mockExperimentalField",
  "experimentalRawEvents",
] as const;

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Orchestrator-agent priming. `thread/resume` accepts a subset — it ignores
 * unknown fields rather than failing, but sending start-only ones would be a
 * lie about what resuming applies. Role MCP servers ride the per-thread config
 * so they exist only in this child's conversation, never in global config.
 */
export function threadParams(
  config: ServerConfig,
  prompts: Prompts,
  kind: "start" | "resume",
  role: Pick<RoleAssets, "mcpServers"> = {},
): Record<string, unknown> {
  const orchestrator = config.orchestrator;
  const params: Record<string, unknown> = {
    cwd: orchestrator.workspace,
  };
  // Upstream rejects the pair; select the profile before the launch opt-in override.
  if (orchestrator.permissions !== undefined) params["permissions"] = orchestrator.permissions;
  else setIfDefined(params, "sandbox", orchestrator.sandbox);
  setIfDefined(params, "approvalPolicy", orchestrator.approvalPolicy);

  setIfDefined(params, "model", orchestrator.model);
  setIfDefined(params, "modelProvider", orchestrator.modelProvider);
  setIfDefined(params, "serviceTier", orchestrator.serviceTier);
  setIfDefined(params, "personality", orchestrator.personality);
  setIfDefined(params, "approvalsReviewer", orchestrator.approvalsReviewer);
  setIfDefined(params, "runtimeWorkspaceRoots", orchestrator.runtimeWorkspaceRoots);
  setIfDefined(params, "baseInstructions", prompts.orchestratorBaseInstructions);
  setIfDefined(params, "developerInstructions", prompts.orchestratorDeveloperInstructions);

  // `effort` is shorthand for a config entry, so an explicit entry wins.
  const codexConfig: Record<string, unknown> = {
    ...(orchestrator.effort ? { model_reasoning_effort: orchestrator.effort } : {}),
    ...orchestrator.config,
  };
  if (prompts.voiceAppend !== undefined) {
    if (Object.hasOwn(codexConfig, STARTUP_CONTEXT_KEY))
      throw appendSlotConflict(`orchestrator.config.${STARTUP_CONTEXT_KEY}`);
    codexConfig[STARTUP_CONTEXT_KEY] = prompts.voiceAppend;
  }
  if (role.mcpServers !== undefined) {
    const configured = codexConfig["mcp_servers"];
    if (configured !== undefined && !record(configured))
      throw new ConfigError("orchestrator.config.mcp_servers must be an object");
    for (const name of Object.keys(role.mcpServers)) {
      if (configured !== undefined && Object.hasOwn(configured, name))
        throw new ConfigError(
          `role ${ROLE_MCP_FILE} and orchestrator.config.mcp_servers both define "${name}"; keep one`,
        );
    }
    codexConfig["mcp_servers"] = { ...(configured ?? {}), ...role.mcpServers };
  }
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
  else for (const field of START_ONLY_FIELDS) delete merged[field];
  if (config.allowFullAccess) applyFullAccessOptIn(merged);
  // Codex rejects both selectors; an explicit profile replaces the sandbox.
  if (merged["permissions"] !== undefined) delete merged["sandbox"];
  if (prompts.voiceAppend !== undefined) {
    const config = merged["config"];
    if (!record(config) || config[STARTUP_CONTEXT_KEY] !== prompts.voiceAppend)
      throw appendSlotConflict("orchestrator.extra.config");
  }
  if (role.mcpServers !== undefined) {
    const config = merged["config"];
    const servers = record(config) ? config["mcp_servers"] : undefined;
    for (const [name, server] of Object.entries(role.mcpServers)) {
      if (!record(servers) || JSON.stringify(servers[name]) !== JSON.stringify(server))
        throw new ConfigError(
          `orchestrator.extra.config replaced the role's MCP server "${name}"; remove that raw override or the role's ${ROLE_MCP_FILE}`,
        );
    }
  }
  return merged;
}

/** Raw passthrough is available for experiments, not an implementation of every native mode. */
export function passthroughWarnings(config: ServerConfig, prompts: Prompts): string[] {
  const warnings: string[] = [];
  const thread = threadParams(config, prompts, "start");
  const realtime = realtimeParams(config, prompts, "", "", "");
  if (Array.isArray(thread["dynamicTools"]) && thread["dynamicTools"].length > 0)
    warnings.push(
      "Raw dynamicTools are advertised only on new conversations. AgentVoice has no client tool handlers; calls will fail. Use native Codex tools for working tools.",
    );
  if (realtime["clientManagedHandoffs"] === true)
    warnings.push(
      "clientManagedHandoffs disables native response forwarding. AgentVoice does not implement client handoffs; Codex work may not reach the voice. Omit this setting or set it to false.",
    );
  const transport = realtime["transport"] as { type?: string; sdp?: string } | null;
  if (
    transport?.type !== "webrtc" ||
    transport.sdp !== "" ||
    realtime["outputModality"] !== "audio"
  )
    warnings.push(
      "Raw transport/outputModality overrides replace AgentVoice's generated WebRTC offer or audio output. This TUI cannot carry alternate media paths; remove these overrides if voice fails.",
    );
  return warnings;
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

  if (prompts.voiceAppend !== undefined) {
    if (voice.includeStartupContext !== undefined)
      throw appendSlotConflict("voice.include-startup-context");
    params["includeStartupContext"] = true;
  } else params["includeStartupContext"] = voice.includeStartupContext ?? false;
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
  if (prompts.voiceAppend !== undefined && merged["includeStartupContext"] !== true)
    throw appendSlotConflict("voice.extra.includeStartupContext");
  const transport = merged["transport"] as { type?: string } | null;
  // Stock 0.153.3 falls back to WebRTC v1, which the current service rejects.
  // Keep explicit overrides (including null) and alternate transports intact.
  if (transport?.type === "webrtc" && merged["version"] === undefined)
    merged["version"] = DEFAULT_WEBRTC_VERSION;
  const version = merged["version"];
  if (transport?.type === "webrtc" && version === "v2")
    throw new ConfigError(
      "Realtime v2 is not supported by Codex's WebRTC transport; omit voice.version for AgentVoice's v3 compatibility default or explicitly select v1/v3 (also check voice.extra.version).",
    );
  const items = merged["initialItems"];
  if (Array.isArray(items) && items.length > 0 && version !== "v3")
    throw new ConfigError(
      'Initial voice items (voice.extra.initialItems) require effective realtime v3. Use AgentVoice\'s WebRTC default or set voice.version to "v3" (and check voice.extra.version), or remove the items. AgentVoice will not discard them or replace an explicit protocol choice.',
    );
  return merged;
}
