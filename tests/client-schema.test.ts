import { expect, test } from "bun:test";
import { buildClientSchema } from "../scripts/generate-client-schema.ts";
import { frontendRequestSchema, frontendServerFrameSchema } from "../src/frontend/protocol.ts";

test("client API schema is generated from the runtime contracts", async () => {
  expect(await Bun.file(new URL("../client.schema.json", import.meta.url)).json()).toEqual(
    buildClientSchema(),
  );
  const call = {
    v: 3,
    type: "request",
    id: "1",
    method: "call",
    params: { clientId: crypto.randomUUID() },
  };
  expect(frontendRequestSchema.safeParse(call).success).toBe(true);
  expect(frontendRequestSchema.safeParse({ ...call, v: 1 }).success).toBe(false);
  expect(
    frontendRequestSchema.safeParse({ ...call, params: { ...call.params, media: "browser" } })
      .success,
  ).toBe(false);
  expect(
    frontendServerFrameSchema.safeParse({
      v: 3,
      type: "client-media",
      message: { type: "prepare", sessionId: crypto.randomUUID(), credential: "forbidden" },
    }).success,
  ).toBe(false);
});
