import { z } from "zod";
import { handoffPromptSchema } from "../core/handoff.ts";
import {
  type MailboxCaller,
  type MailboxOpenParams,
  mailboxOpenParams,
  mailboxOpenResultSchema,
} from "../mailbox/contract.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlBackend,
  ControlError,
  type ControlMutationRequest,
  type ControlRestartRequest,
} from "./types.ts";

const operationId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const mutation = z
  .object({
    operationId,
    expectedGeneration: z.number().int().nonnegative(),
    expectedInstanceId: z.string().min(1).max(256),
  })
  .strict();

export const controlOperationSchema = z
  .object({
    operationId,
    kind: z.enum(["redial", "restart"]),
    scope: z.enum(["voice", "runtime"]),
    expectedGeneration: z.number().int().nonnegative(),
    expectedInstanceId: z.string().min(1),
    phase: z.enum([
      "accepted",
      "quiescing",
      "interrupted",
      "forced",
      "starting",
      "ready",
      "failed",
    ]),
    acceptedAt: z.string(),
    updatedAt: z.string(),
    forced: z.boolean().optional(),
    result: z
      .object({
        generation: z.number().int().nonnegative(),
        threadId: z.string(),
        workspace: z.string(),
        pid: z.number().int().positive().optional(),
        buildId: z.string().optional(),
      })
      .strict()
      .optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    handoff: z
      .object({
        status: z.enum(["pending", "submitting", "accepted", "failed", "unknown"]),
        clientUserMessageId: z.string().min(1).max(128),
        turnId: z.string().min(1).max(256).optional(),
        error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const controlStatusSchema = z
  .object({
    protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    instanceId: z.string().min(1),
    // The controller binds before the candidate runtime has discovered the
    // exact workspace/thread. Empty strings are valid only during that state.
    workspace: z.string(),
    threadId: z.string(),
    generation: z.number().int().nonnegative(),
    runtime: z
      .object({
        pid: z.number().int().positive().optional(),
        buildId: z.string().optional(),
        phase: z.string(),
        voicePhase: z.string().optional(),
        attachmentReady: z.boolean().optional(),
      })
      .strict(),
    currentOperation: controlOperationSchema.optional(),
    recentOperations: z.array(controlOperationSchema).max(100),
  })
  .strict();

const restart = mutation
  .extend({ scope: z.literal("runtime"), handoffPrompt: handoffPromptSchema.optional() })
  .strict();

export type ControlMethod =
  | "agentvoice.status"
  | "agentvoice.redial"
  | "agentvoice.restart"
  | "agentvoice.thread_mailbox_open";

export type ControlMethodEntry = {
  tool: string;
  description: string;
  params: z.ZodType;
  result: z.ZodType;
  readOnly: boolean;
  invoke(backend: ControlBackend, params: unknown, caller?: MailboxCaller): Promise<unknown>;
};

export const CONTROL_METHODS: Record<ControlMethod, ControlMethodEntry> = {
  "agentvoice.thread_mailbox_open": {
    tool: "agentvoice_thread_mailbox_open",
    description:
      "Open this orchestrator's thread mailbox: return and clear completion metadata, with a fresh snapshot of children still working. Full child results arrive through native Codex. Use the notice's operationId and expectedInstanceId; reuse an operationId only to retry that same opening. If remainingCompleted is nonzero, open again with a new operationId. Old notices may yield an empty mailbox. No per-message read receipts.",
    params: mailboxOpenParams,
    result: mailboxOpenResultSchema,
    readOnly: false,
    invoke: (backend, params, caller) => backend.mailboxOpen(params as MailboxOpenParams, caller),
  },
  "agentvoice.status": {
    tool: "agentvoice_status",
    description: "Read the controller-bound voice/runtime state and recent durable operations.",
    params: z.object({}).strict(),
    result: controlStatusSchema,
    readOnly: true,
    invoke: async (backend) => await backend.status(),
  },
  "agentvoice.redial": {
    tool: "agentvoice_redial",
    description:
      "Accept an idempotent voice/WebRTC redial for this controller instance and generation. It does not reload runtime code or configuration.",
    params: mutation,
    result: controlOperationSchema,
    readOnly: false,
    invoke: async (backend, params) => await backend.redial(params as ControlMutationRequest),
  },
  "agentvoice.restart": {
    tool: "agentvoice_restart_runtime",
    description:
      "Accept an idempotent full runtime restart for this controller instance and generation. Optional handoffPrompt is submitted once as native working-agent input after the same conversation and voice are ready. Recover restart and handoff status with agentvoice_status; acceptance does not confirm execution or speech.",
    params: restart,
    result: controlOperationSchema,
    readOnly: false,
    invoke: async (backend, params) => await backend.restart(params as ControlRestartRequest),
  },
};

export async function dispatchControl(
  backend: ControlBackend,
  method: string,
  params: unknown,
  caller?: MailboxCaller,
): Promise<unknown> {
  const entry = CONTROL_METHODS[method as ControlMethod];
  if (!entry) throw new ControlError("unknown_method", `unknown method "${method}"`);
  const checked = entry.params.safeParse(params ?? {});
  if (!checked.success) {
    const message = checked.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join("; ");
    throw new ControlError("invalid_params", message);
  }
  const result = await entry.invoke(backend, checked.data, caller);
  const output = entry.result.safeParse(result);
  if (!output.success)
    throw new ControlError("internal_error", "controller returned an invalid result");
  return output.data;
}

export type SocketResponse =
  | { v: number; type: "response"; id: string | null; ok: true; result: unknown }
  | {
      v: number;
      type: "response";
      id: string | null;
      ok: false;
      error: { code: string; message: string };
    };

export function errorResponse(id: string | null, error: unknown): SocketResponse {
  const code = error instanceof ControlError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  return { v: CONTROL_PROTOCOL_VERSION, type: "response", id, ok: false, error: { code, message } };
}
