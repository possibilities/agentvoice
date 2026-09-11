import { describe, expect, test } from "bun:test";
import fixtures from "../android/contract/server-frames.json";
import { frontendServerFrameSchema } from "../src/frontend/protocol.ts";
import { heartbeatSchema } from "../src/network/protocol.ts";

describe("Android client shared server-frame fixtures", () => {
  const frame = frontendServerFrameSchema.or(heartbeatSchema);
  test("accepted Android messages belong to the frontend v3 and heartbeat v2 contracts", () => {
    for (const value of fixtures.valid) expect(frame.safeParse(value).success).toBe(true);
  });
  test("hostile Android fixtures are rejected by the server contract too", () => {
    for (const value of fixtures.invalid) expect(frame.safeParse(value).success).toBe(false);
  });
});
