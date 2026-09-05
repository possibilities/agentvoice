import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConfigValues, type Prompts, resolveConfig } from "../src/core/config.ts";
import { realtimeParams, threadParams } from "../src/core/params.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const config = (values: ConfigValues = {}) => resolveConfig({}, values, {}, "/test");
const params = (values: ConfigValues = {}, prompts: Prompts = {}) =>
  realtimeParams(config(values), prompts, "thread", "session", "sdp");

describe("native realtime defaults", () => {
  test("omits version and does not copy the general native config into the WebRTC request", () => {
    const values = { orchestrator: { config: { realtime: { version: "v3" } } } };
    expect(config().voice.version).toBeUndefined();
    expect(params()).not.toHaveProperty("version");
    expect(params(values)).toEqual(params());
    expect(threadParams(config(values), {}, "start")["config"]).toEqual(values.orchestrator.config);
  });

  test("explicit supported versions and raw overrides stay intact", () => {
    for (const version of ["v1", "v3"] as const)
      expect(params({ voice: { version } })["version"]).toBe(version);
    const seed = [{ role: "user", text: "seed" }];
    expect(
      params({
        voice: { version: "v1", extra: { version: "v3", initialItems: seed, futureField: 7 } },
      }),
    ).toMatchObject({ version: "v3", initialItems: seed, futureField: 7 });
    expect(params({ voice: { version: "v3", extra: { version: null } } })["version"]).toBeNull();
  });

  test("all seed files, even empty ones, require explicit v3 without stripping their contents", () => {
    for (const key of ["voiceSeedDeveloper", "voiceSeedUser", "voiceSeedAssistant"] as const) {
      for (const text of ["", "seed text"]) {
        const prompts = { [key]: text };
        for (const version of [undefined, "v1"] as const)
          expect(() => params({ voice: { version } }, prompts)).toThrow(
            "require explicit realtime v3",
          );
        expect(params({ voice: { version: "v3" } }, prompts)["initialItems"]).toEqual([
          { role: key.slice(9).toLowerCase(), text },
        ]);
        expect(() =>
          params({ voice: { version: "v3", extra: { version: null } } }, prompts),
        ).toThrow("require explicit realtime v3");
      }
    }
  });

  test("checks the final merged seed array and version; intentional empty overrides remain possible", () => {
    const seed = [{ role: "user", text: "seed" }];
    expect(() => params({ voice: { extra: { initialItems: seed } } })).toThrow(
      "voice.extra.initialItems",
    );
    expect(
      params({ voice: { extra: { initialItems: [] } } }, { voiceSeedUser: "replaced explicitly" })[
        "initialItems"
      ],
    ).toEqual([]);
    expect(
      params({ voice: { extra: { version: "v3" } } }, { voiceSeedUser: "seed" }),
    ).toMatchObject({ version: "v3", initialItems: seed });
  });

  test("rejects WebRTC v2 but leaves a raw websocket transport's protocol choice alone", () => {
    expect(() => params({ voice: { version: "v2" } })).toThrow("WebRTC");
    expect(() => params({ voice: { version: "v3", extra: { version: "v2" } } })).toThrow("WebRTC");
    expect(
      params({ voice: { version: "v2", extra: { transport: { type: "websocket" } } } }),
    ).toMatchObject({ version: "v2", transport: { type: "websocket" } });
  });

  test("invalid seed setup fails before any native connection, history lookup or resume", async () => {
    const h = runtimeHarness({}, { resume: "existing" });
    writeFileSync(join(h.directory, "VOICE_SEED_USER.md"), "seed");
    try {
      await expect(h.runtime.start()).rejects.toThrow("require explicit realtime v3");
      expect(h.native.options).toBeUndefined();
      expect(h.native.calls).toEqual([]);
      expect(h.ready).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("default omission and explicit v3 survive continue, redial and Fresh", async () => {
    for (const version of [undefined, "v3"] as const) {
      const h = runtimeHarness({ voice: { version } });
      h.native.main("existing", h.directory);
      try {
        await h.runtime.start();
        h.runtime.offer("offer-1");
        h.runtime.offer("redial");
        await h.runtime.fresh();
        h.runtime.offer("fresh-offer");
        const starts = h.native.calls.filter((c) => c.method === "thread/realtime/start");
        expect(starts).toHaveLength(3);
        for (const start of starts) {
          if (version === undefined) expect(start.params).not.toHaveProperty("version");
          else expect(start.params["version"]).toBe(version);
        }
        expect(starts[0]!.params["threadId"]).toBe("existing");
        expect(starts[2]!.params["threadId"]).not.toBe("existing");
      } finally {
        await h.cleanup();
      }
    }
  });
});
