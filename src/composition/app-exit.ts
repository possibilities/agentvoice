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
  if (code === 0 && signal === null) return;
  const detail =
    signal !== null ? `signal ${signal}` : code !== null ? `code ${code}` : "unknown status";
  return new Error(`${app.name} app exited with ${detail}`);
}
