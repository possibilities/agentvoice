import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readHud } from "./api.ts";
import { batchSchema, mutationSchema } from "./contract.ts";
import { guideEnvelope } from "./guide.ts";
import { WorkError, WorkStore } from "./store.ts";

export function buildHudMcp(store: WorkStore): McpServer {
  const server = new McpServer(
    { name: "agenthud", version: "1.0.0" },
    {
      instructions:
        "Read agenthud_guide. Durable Work only: never spawn, resume or infer approval. Native dispatch and returns remain native. Actors are local-user declarations. Reads do not establish result acceptance or human presentation.",
    },
  );
  const result = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  });
  const failure = (error: unknown) => ({
    ...result({
      error: {
        code:
          error instanceof WorkError
            ? error.code
            : error instanceof z.ZodError
              ? "invalid_input"
              : "internal",
        message:
          error instanceof WorkError || error instanceof z.ZodError
            ? error.message
            : "Work operation failed",
      },
    }),
    isError: true,
  });
  server.registerTool(
    "agenthud_guide",
    {
      description: "Read the Work protocol and exact mutation schemas.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result(guideEnvelope),
  );
  server.registerTool(
    "agenthud_snapshot",
    {
      description: "Read durable Work and optionally a fresh bounded native observation.",
      inputSchema: z.object({ native: z.boolean().default(false) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ native }) => {
      try {
        return result(native ? await readHud(store) : store.snapshot());
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "agenthud_apply",
    {
      description:
        "Apply one durable mutation. Retry only the identical payload and operation ID after an unknown response.",
      inputSchema: z.object({ mutation: mutationSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ mutation }) => {
      try {
        return result(store.mutate(mutation));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "agenthud_batch",
    {
      description: "Apply a group of Work changes in one durable transaction.",
      inputSchema: batchSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (batch) => {
      try {
        return result({ records: store.batch(batch) });
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}
export async function runHudMcp(): Promise<void> {
  const store = new WorkStore();
  const server = buildHudMcp(store);
  const transport = new StdioServerTransport();
  server.server.onclose = () => store.close();
  await server.connect(transport);
}
