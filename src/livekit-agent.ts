import { resolve } from "node:path";
import { defineAgent, type JobContext, llm, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { RoomEvent } from "@livekit/rtc-node";
import { z } from "zod";
import { FxDelegationController } from "./fx-delegation.ts";
import { type FxAdeEvent, FxHeadlessOrchestrator } from "./fx-orchestrator.ts";
import { LiveKitJobResourceStopper } from "./livekit-job-lifecycle.ts";
import { LiveKitTelemetryClient } from "./livekit-telemetry.ts";

export { FxDelegationController } from "./fx-delegation.ts";

export const LIVEKIT_AGENT_NAME = "agentvoice-livekit-contender";
export const LIVEKIT_VOICE_MODEL = "gpt-realtime-2.1";
export const LIVEKIT_VOICE = "marin";
export const LIVEKIT_REASONING_EFFORT = "medium";
export const FX_ORCHESTRATOR_MODEL = "gpt-5.6-terra";
export const FX_REASONING_EFFORT = "medium";

const FINAL_HANDOFF_TEMPLATE = "{message}";
const FINAL_HANDOFF_REPLY_AT_TAIL =
  "A completed background coding result has arrived (call_ids: {callIds}). " +
  "It is authoritative and replaces earlier progress saying the work was still running. " +
  "Give the user a concise, accurate spoken report now in at most 80 words and four short " +
  "sentences; do not say the work is still running.";
const FINAL_HANDOFF_REPLY_MAYBE_COVERED =
  "A completed background coding result has arrived (call_ids: {callIds}). " +
  "It is authoritative and replaces earlier progress saying the work was still running. " +
  "If the user has not already heard this completed result, report it now in at most 80 words and " +
  "four short sentences. " +
  "If it was already fully reported, reply with no text; never revert to a still-running status.";

const jobMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(256),
    workspace: z.string().min(1),
    orchestratorModel: z.literal(FX_ORCHESTRATOR_MODEL),
    reasoningEffort: z.literal(FX_REASONING_EFFORT),
  })
  .strict();

export type LiveKitAgentJobMetadata = z.infer<typeof jobMetadataSchema>;

export function parseLiveKitAgentJobMetadata(
  serialized: string,
  expected: { runId: string; workspace: string },
): LiveKitAgentJobMetadata {
  const metadata = jobMetadataSchema.parse(JSON.parse(serialized));
  if (metadata.runId !== expected.runId) {
    throw new Error("LiveKit job metadata run ID did not match its telemetry environment");
  }
  if (resolve(metadata.workspace) !== resolve(expected.workspace)) {
    throw new Error("LiveKit job metadata workspace did not match the worker assignment");
  }
  return metadata;
}

/**
 * LiveKit records AgentConfigUpdate markers in local history, but the OpenAI Realtime adapter
 * cannot serialize those markers as conversation items. Filter only at the provider boundary so
 * LiveKit retains its complete history while every OpenAI chat-context sync remains valid.
 */
export class AgentVoiceRealtimeSession extends openai.realtime.RealtimeSession {
  override updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    return super.updateChatCtx(openAIRealtimeChatContext(chatCtx));
  }

  protected override createChatCtxUpdateEvents(chatCtx: llm.ChatContext, addMockAudio = false) {
    return super.createChatCtxUpdateEvents(openAIRealtimeChatContext(chatCtx), addMockAudio);
  }
}

export function openAIRealtimeChatContext(chatCtx: llm.ChatContext): llm.ChatContext {
  return chatCtx.copy({ excludeConfigUpdate: true });
}

export class AgentVoiceRealtimeModel extends openai.realtime.RealtimeModel {
  override session(): AgentVoiceRealtimeSession {
    return new AgentVoiceRealtimeSession(this);
  }
}

export function createDelegateTool(controller: FxDelegationController) {
  return llm.tool({
    name: "delegate_to_orchestrator",
    description:
      "Delegate every request that requires inspecting, explaining, editing, testing, or otherwise " +
      "working in the current code checkout. Call this tool again immediately when the user adds " +
      "or changes a constraint while coding work is active; duplicate calls intentionally steer " +
      "that same work. Never answer checkout-specific questions from memory.",
    parameters: z.object({
      request: z
        .string()
        .min(1)
        .describe("A self-contained coding instruction preserving every constraint from the user."),
    }),
    onDuplicate: "allow",
    execute: async ({ request }, { ctx }) =>
      controller.delegate(request, (message, phase) => {
        if (phase === "result") {
          return ctx.update(message, { template: FINAL_HANDOFF_TEMPLATE });
        }
        return ctx.update(message);
      }),
  });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const socketPath = requiredEnvironment("AGENTVOICE_TELEMETRY_SOCKET_PATH");
    const environmentRunId = requiredEnvironment("AGENTVOICE_TELEMETRY_RUN_ID");
    const expectedWorkspace = requiredEnvironment("AGENTVOICE_EXPECTED_WORKSPACE");
    const metadata = parseLiveKitAgentJobMetadata(ctx.job.metadata, {
      runId: environmentRunId,
      workspace: expectedWorkspace,
    });
    const telemetry = new LiveKitTelemetryClient({
      socketPath,
      runId: metadata.runId,
    });

    await ctx.connect();

    await telemetry.emit("livekit", "livekit.job.started", {
      room: ctx.room.name ?? null,
      workspace: metadata.workspace,
    });

    let shuttingDown = false;
    const emitOrShutdown = (
      source: "livekit" | "fx",
      type: string,
      data: Record<string, unknown> = {},
    ) => {
      void telemetry.emit(source, type, data).catch((error) => {
        if (shuttingDown) return;
        shuttingDown = true;
        ctx.shutdown(`telemetry failure: ${errorMessage(error)}`);
      });
    };

    let orchestrator: FxHeadlessOrchestrator | null = null;
    const jobResourceStopper = new LiveKitJobResourceStopper({
      stopResource: () => orchestrator?.stop() ?? Promise.resolve(),
      telemetry,
      roomName: () => ctx.room.name ?? null,
      onStopping: () => {
        shuttingDown = true;
      },
    });
    const requestResourceStop = (reason: string): void => {
      void jobResourceStopper.stop(reason).catch(() => {});
    };
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      requestResourceStop(`participant_disconnected:${participant.identity}`);
    });
    ctx.addShutdownCallback(() => jobResourceStopper.stop("framework_shutdown"));

    await jobResourceStopper.runGuarded("entry_failed", async () => {
      const activeOrchestrator = new FxHeadlessOrchestrator({
        workspace: metadata.workspace,
        ...(process.env["AGENTVOICE_FX_PATH"] ? { fxPath: process.env["AGENTVOICE_FX_PATH"] } : {}),
        model: metadata.orchestratorModel,
        reasoningEffort: metadata.reasoningEffort,
        ...(process.env["AGENTVOICE_FX_TERMINAL_LOG_PATH"]
          ? { terminalLogPath: process.env["AGENTVOICE_FX_TERMINAL_LOG_PATH"] }
          : {}),
        ...(process.env["AGENTVOICE_FX_STDERR_LOG_PATH"]
          ? { stderrLogPath: process.env["AGENTVOICE_FX_STDERR_LOG_PATH"] }
          : {}),
        onAdeEvent: (event) => recordFxEvent(event, emitOrShutdown),
        onProtocolError: (error) =>
          emitOrShutdown("fx", "fx.ade.protocol-error", { message: error.message }),
      });
      orchestrator = activeOrchestrator;
      const identity = await activeOrchestrator.start();
      await telemetry.emit("fx", "fx.identity", { ...identity });

      const controller = new FxDelegationController(activeOrchestrator, {
        emit: (type, data) => telemetry.emit("livekit", type, data),
      });
      const realtimeModel = new AgentVoiceRealtimeModel({
        model: LIVEKIT_VOICE_MODEL,
        reasoning: { effort: LIVEKIT_REASONING_EFFORT },
        voice: LIVEKIT_VOICE,
        turnDetection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
        },
      });
      const session = new voice.AgentSession({
        llm: realtimeModel,
        vad: null,
        maxToolSteps: 8,
        userAwayTimeout: null,
        toolHandling: {
          asyncOptions: {
            replyAtTailTemplate: FINAL_HANDOFF_REPLY_AT_TAIL,
            replyMaybeCoveredTemplate: FINAL_HANDOFF_REPLY_MAYBE_COVERED,
          },
        },
        turnHandling: {
          turnDetection: "realtime_llm",
          interruption: { enabled: true },
        },
      });
      wireSessionTelemetry(session, emitOrShutdown, () => {
        requestResourceStop("voice_session_closed");
      });

      await session.start({
        agent: new voice.Agent({
          instructions:
            "You are a concise, highly capable realtime coding voice agent. You converse naturally " +
            "with the user while a persistent coding orchestrator works in the checkout. For every " +
            "checkout-specific question or requested code action, call delegate_to_orchestrator. " +
            "Call it silently, without a spoken preamble. Never pretend you inspected, changed, or " +
            "tested code yourself. The delegation is asynchronous: after its progress update, " +
            "acknowledge exactly once in at most eight spoken words and remain fully responsive. If " +
            "the user interrupts or adds a constraint while work is active, immediately call the same " +
            "tool again so it steers the active turn; do not cancel or replace the work. Wait for the " +
            "original delegation result before reporting completion. Completed-result reports must be " +
            "at most 80 spoken words and four short sentences while still naming concrete behavior " +
            "changes, verification, and remaining risks when relevant.",
          tools: [createDelegateTool(controller)],
        }),
        room: ctx.room,
      });
      await telemetry.emit("livekit", "voice.session.started", {
        voiceModel: LIVEKIT_VOICE_MODEL,
        voice: LIVEKIT_VOICE,
        reasoningEffort: LIVEKIT_REASONING_EFFORT,
        turnDetection: "semantic_vad",
        interruptionEnabled: true,
        orchestratorModel: metadata.orchestratorModel,
        orchestratorReasoningEffort: metadata.reasoningEffort,
      });
    });
  },
});

function wireSessionTelemetry(
  session: voice.AgentSession,
  emit: (source: "livekit" | "fx", type: string, data?: Record<string, unknown>) => void,
  onClose: () => void,
): void {
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    emit("livekit", event.isFinal ? "input.transcript.done" : "input.transcript.delta", {
      text: event.transcript,
      itemId: event.itemId,
      language: event.language,
    });
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item.type !== "message" || event.item.role !== "assistant") return;
    emit("livekit", "output.transcript.done", {
      itemId: event.item.id,
      text: event.item.textContent ?? "",
      interrupted: event.item.interrupted,
    });
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
    emit("livekit", "voice.agent.state", {
      oldState: event.oldState,
      newState: event.newState,
    });
  });
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    emit("livekit", "voice.user.state", {
      oldState: event.oldState,
      newState: event.newState,
    });
  });
  session.on(voice.AgentSessionEventTypes.OverlappingSpeech, (event) => {
    emit("livekit", "voice.overlapping-speech", {
      isInterruption: event.isInterruption,
    });
  });
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
    emit("livekit", "voice.tools.executed", {
      calls: event.functionCalls.map((call) => ({
        callId: call.callId,
        name: call.name,
        args: call.args,
      })),
      outputs: event.functionCallOutputs.map((output) => ({
        callId: output.callId,
        name: output.name,
        isError: output.isError,
        output: output.output,
      })),
    });
  });
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => {
    emit("livekit", "voice.metrics.collected", { metrics: event.metrics });
  });
  session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, (event) => {
    emit("livekit", "voice.usage.updated", { usage: event.usage });
  });
  session.on(voice.AgentSessionEventTypes.Error, (event) => {
    emit("livekit", "voice.error", { message: errorMessage(event.error) });
  });
  session.on(voice.AgentSessionEventTypes.Close, (event) => {
    emit("livekit", "voice.session.closed", {
      reason: event.reason,
      error: event.error ? errorMessage(event.error) : null,
    });
    onClose();
  });
}

function recordFxEvent(
  event: FxAdeEvent,
  emit: (source: "livekit" | "fx", type: string, data?: Record<string, unknown>) => void,
): void {
  const data = {
    adeSequence: event.sequence,
    event: event.event,
    context: event.context,
    payload: event.payload,
  };
  emit("fx", `fx.ade.${event.event.toLowerCase()}`, data);
  if (event.context.agent_role !== "main" || event.context.turn_id === null) return;
  if (event.event === "TurnStarted") {
    emit("fx", "orchestrator.turn.started", {
      turnId: String(event.context.turn_id),
      status: "inProgress",
      adeSequence: event.sequence,
    });
  } else if (event.event === "PostTurnEnd") {
    const outcome = event.payload["outcome"] ?? null;
    emit("fx", "orchestrator.turn.completed", {
      turnId: String(event.context.turn_id),
      status: outcome === "completed" ? "completed" : outcome,
      error: outcome === "completed" ? null : `Fx turn ended ${String(outcome)}`,
      outcome,
      providerDisposition: event.payload["provider_disposition"] ?? null,
      adeSequence: event.sequence,
    });
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
