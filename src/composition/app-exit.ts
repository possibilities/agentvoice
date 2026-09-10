import { z } from "zod";

export const appSchema = z.object({
  name: z.string(),
  state: z.string(),
  error: z.string().nullable().optional(),
  lastExit: z
    .object({ code: z.number().int().nullable(), signal: z.number().int().nullable() })
    .nullable()
    .optional(),
});

export function appFailure(app: z.infer<typeof appSchema>): Error | undefined {
  if (app.state === "failed") return new Error(app.error ?? `${app.name} app failed`);
  if (app.state !== "exited" || !app.lastExit) return;
  const { code, signal } = app.lastExit;
  // The local PTY helper uses zero for an ordinary exit; Companion may use null.
  const signalled = signal !== null && signal > 0;
  if (code === 0 && !signalled) return;
  const detail = signalled ? `signal ${signal}` : code !== null ? `code ${code}` : "unknown status";
  return new Error(`${app.name} app exited with ${detail}`);
}
