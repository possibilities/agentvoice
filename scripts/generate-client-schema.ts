import { z } from "zod";
import { frontendRequestSchema, frontendServerFrameSchema } from "../src/frontend/protocol.ts";
import { heartbeatSchema } from "../src/network/protocol.ts";

export function buildClientSchema() {
  return {
    ...z.toJSONSchema(
      z.union([frontendRequestSchema, frontendServerFrameSchema, heartbeatSchema]),
      {
        target: "draft-2020-12",
        io: "input",
        reused: "ref",
      },
    ),
    title: "AgentVoice frontend API v3 with network v2 heartbeats",
    description:
      "Exclusive call ownership and client-owned media signaling. See docs/client-api.md. No credentials or audio bytes.",
  };
}
if (import.meta.main)
  await Bun.write(
    new URL("../client.schema.json", import.meta.url),
    `${JSON.stringify(buildClientSchema(), null, 2)}\n`,
  );
