import { z } from "zod";
export const NETWORK_SUBPROTOCOL = "agentvoice.v2";
export const NETWORK_PATH = "/v2/client";
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 20_000;
export const MAX_NETWORK_FRAME_BYTES = 1024 * 1024;
export const heartbeatSchema = z
  .object({
    v: z.literal(2),
    type: z.enum(["ping", "pong"]),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
