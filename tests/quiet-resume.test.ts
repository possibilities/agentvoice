import { describe, expect, test } from "bun:test";
import { type ConfigValues, resolveConfig } from "../src/core/config.ts";
import { QUIET_RESUME_INSTRUCTION, realtimeParams } from "../src/core/params.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const instruction = [{ role: "developer", text: QUIET_RESUME_INSTRUCTION }];
const params = (values: ConfigValues = {}, reconnect = true) =>
  realtimeParams(resolveConfig({}, values, {}, "/test"), {}, "thread", "call", "sdp", reconnect);

describe("quiet voice resume", () => {
  test("keeps native prompts/context and uses one developer item only on reconnect", () => {
    const first = params({}, false);
    expect(first).not.toHaveProperty("initialItems");
    expect(params()).toEqual({ ...first, initialItems: instruction });
    expect(params()).not.toHaveProperty("prompt");
    expect(params()["includeStartupContext"]).toBe(false);
    expect(params()).not.toHaveProperty("flushTranscriptTailOnSessionEnd");
    expect(params()).not.toHaveProperty("quietResume");
  });

  test("explicit opt-out, initial items and protocol/transport choices keep their meaning", () => {
    expect(params({ voice: { "quiet-resume": false } })).not.toHaveProperty("initialItems");
    for (const initialItems of [[], null, [{ role: "user", text: "Operator startup" }]])
      expect(params({ voice: { extra: { initialItems } } })["initialItems"]).toEqual(initialItems);
    for (const version of [null, "v1"])
      expect(params({ voice: { extra: { version } } })).not.toHaveProperty("initialItems");
    for (const transport of [{ type: "websocket" }, { type: "existingCall", callId: "call" }])
      expect(params({ voice: { version: "v3", extra: { transport } } })).not.toHaveProperty(
        "initialItems",
      );
  });

  for (const resume of [undefined, "existing"]) {
    test(`${resume ? "explicit resume" : "continue"} with no saved speech preserves identity and adds no work turn`, async () => {
      const h = runtimeHarness({}, { resume });
      h.native.main("existing", h.directory);
      try {
        await h.runtime.start();
        await h.runtime.offer("reconnect");
        expect(h.native.calls.at(-1)!.params).toMatchObject({
          threadId: "existing",
          initialItems: instruction,
        });
        expect(h.native.calls.some((c) => c.method === "thread/resume")).toBe(true);
        expect(h.native.calls.some((c) => c.method === "thread/start")).toBe(false);
        expect(h.native.calls.some((c) => c.method === "turn/start")).toBe(false);
        expect(h.native.calls.some((c) => c.method === "thread/realtime/appendText")).toBe(false);
      } finally {
        await h.cleanup();
      }
    });
  }

  test("first connection stays native, closed/error calls redial quietly, Fresh resets the boundary", async () => {
    const h = runtimeHarness({}, { fresh: true });
    const offer = async (quiet: boolean) => {
      await h.runtime.offer("sdp");
      const call = h.native.calls.at(-1)!;
      expect(call.params["initialItems"]).toEqual(quiet ? instruction : undefined);
      return call.params;
    };
    try {
      await h.runtime.start();
      const first = await offer(false);
      // An obsolete notification must not turn a failed first attempt into a reconnect.
      h.native.options.onNotification("thread/realtime/started", {
        threadId: first["threadId"],
        realtimeSessionId: "obsolete",
      });
      const retry = await offer(false);
      h.native.options.onNotification("thread/realtime/started", retry);
      await offer(true);
      h.native.options.onNotification("thread/realtime/closed", {
        threadId: first["threadId"],
        reason: "transport_closed",
      });
      await offer(true);
      h.native.options.onNotification("thread/realtime/error", {
        threadId: first["threadId"],
        message: "transport failed",
      });
      await offer(true);
      await h.runtime.fresh();
      const fresh = await offer(false);
      expect(fresh["threadId"]).not.toBe(first["threadId"]);
    } finally {
      await h.cleanup();
    }
  });

  test("failed Fresh keeps the old conversation's reconnect policy", async () => {
    const h = runtimeHarness({}, { fresh: true });
    try {
      await h.runtime.start();
      await h.runtime.offer("first");
      const first = h.native.calls.at(-1)!.params;
      h.native.options.onNotification("thread/realtime/started", first);
      h.native.override = (method) =>
        method === "thread/start" ? Promise.reject(new Error("new thread failed")) : undefined;
      await h.runtime.fresh();
      expect(first["threadId"]).toBe(h.runtime.currentReady!.threadId);
      await h.runtime.offer("reconnect after failed Fresh");
      expect(h.native.calls.at(-1)!.params["initialItems"]).toEqual(instruction);
    } finally {
      await h.cleanup();
    }
  });
});
