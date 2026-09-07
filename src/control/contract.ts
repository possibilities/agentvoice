import { z } from "zod";
import { CONTROL_PROTOCOL_VERSION, type ControlBackend, ControlError } from "./types.ts";

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
      })
      .strict(),
  })
  .strict();

export type ControlMethod = "agentvoice.status";

export type ControlMethodEntry = {
  tool: string;
  description: string;
  params: z.ZodType;
  result: z.ZodType;
  readOnly: boolean;
  invoke(backend: ControlBackend, params: unknown): Promise<unknown>;
};

export const CONTROL_METHODS: Record<ControlMethod, ControlMethodEntry> = {
  "agentvoice.status": {
    tool: "agentvoice_status",
    description: "Read the current call state.",
    params: z.object({}).strict(),
    result: controlStatusSchema,
    readOnly: true,
    invoke: async (backend) => await backend.status(),
  },
};

export async function dispatchControl(
  backend: ControlBackend,
  method: string,
  params: unknown,
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
  const result = await entry.invoke(backend, checked.data);
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
