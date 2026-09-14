import { expect, test } from "bun:test";
import {
  compatibleVoiceCatalog,
  NativeVoiceCatalog,
  nativeVoiceCatalogResultSchema,
} from "../src/core/voice-catalog.ts";

const voices = {
  v1: ["arbor", "breeze"],
  v2: ["cedar", "dawn"],
  defaultV1: "arbor",
  defaultV2: "cedar",
};

test("reads and validates the native voice catalog without substituting static voices", async () => {
  const calls: Array<[string, unknown]> = [];
  const catalog = new NativeVoiceCatalog(async (method, params) => {
    calls.push([method, params]);
    return { voices };
  });

  const result = await catalog.read();
  expect(calls).toEqual([["thread/realtime/listVoices", {}]]);
  expect(result).toMatchObject({
    status: "available",
    source: "thread/realtime/listVoices",
    voices,
  });
  expect(result.status === "available" && result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  expect(nativeVoiceCatalogResultSchema.safeParse(result).success).toBe(true);
});

test("rejects malformed native catalog shapes, duplicate ids, default mismatches, and bounds", async () => {
  const malformed = [
    {},
    { voices: { ...voices, v1: [] } },
    { voices: { ...voices, v1: ["arbor", "arbor"] } },
    { voices: { ...voices, defaultV1: "not-listed" } },
    { voices: { ...voices, v2: [" "] } },
    { voices: { ...voices, v1: ["a".repeat(129)] } },
    { voices: { ...voices, v2: Array.from({ length: 129 }, (_, index) => `v${index}`) } },
  ];

  for (const response of malformed) {
    const catalog = new NativeVoiceCatalog(async () => response);
    expect(await catalog.read()).toEqual({
      status: "unavailable",
      source: "thread/realtime/listVoices",
      error: "Native voice catalog returned an invalid response.",
    });
  }
});

test("classifies failures without exposing native exception details and retries failures", async () => {
  let calls = 0;
  const catalog = new NativeVoiceCatalog(async () => {
    calls++;
    if (calls === 1) throw new Error("Method not found: receipt-token-should-not-leak");
    if (calls === 2) throw new Error("invalid request contains another-private-value");
    if (calls === 3) throw new Error("socket closed with secret");
    return { voices };
  });

  const first = await catalog.read();
  const second = await catalog.read();
  const third = await catalog.read();
  expect(first).toMatchObject({
    status: "unavailable",
    error: "Native voice catalog is unsupported by this Codex runtime.",
  });
  expect(second).toMatchObject({
    status: "unavailable",
    error: "Native voice catalog request was invalid.",
  });
  expect(third).toMatchObject({
    status: "unavailable",
    error: "Native voice catalog request failed.",
  });
  expect((await catalog.read()).status).toBe("available");
  expect(calls).toBe(4);
});

test("caches successful reads, refreshes explicitly, and deduplicates concurrent reads", async () => {
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  let calls = 0;
  const catalog = new NativeVoiceCatalog(async () => {
    calls++;
    return calls === 1 ? first.promise : second.promise;
  });

  const pending = [catalog.read(), catalog.read(), catalog.read(true)];
  expect(calls).toBe(1);
  first.resolve({ voices });
  const [one, two, three] = await Promise.all(pending);
  expect(one).toEqual(two);
  expect(two).toEqual(three);
  expect(await catalog.read()).toEqual(one!);
  expect(calls).toBe(1);

  const refresh = catalog.read(true);
  const sameRefresh = catalog.read(true);
  expect(calls).toBe(2);
  second.resolve({ voices: { ...voices, defaultV1: "breeze" } });
  expect(await refresh).toMatchObject({ status: "available", voices: { defaultV1: "breeze" } });
  expect(await sameRefresh).toMatchObject({ status: "available", voices: { defaultV1: "breeze" } });
  expect(calls).toBe(2);
});

test("a new owned-child catalog does not inherit an earlier instance cache", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return { voices };
  };
  await new NativeVoiceCatalog(request).read();
  await new NativeVoiceCatalog(request).read();
  expect(calls).toBe(2);
});

test("v1 and v3 expose the v1 family, while unknown protocol has no compatible choice", async () => {
  const available = await new NativeVoiceCatalog(async () => ({ voices })).read();
  expect(compatibleVoiceCatalog(available, "v1")).toEqual({
    protocol: "v1",
    choices: ["arbor", "breeze"],
    defaultVoice: "arbor",
  });
  expect(compatibleVoiceCatalog(available, "v3")).toEqual({
    protocol: "v3",
    choices: ["arbor", "breeze"],
    defaultVoice: "arbor",
  });
  expect(compatibleVoiceCatalog(available, null)).toEqual({
    protocol: null,
    choices: [],
    defaultVoice: null,
  });
  expect(
    compatibleVoiceCatalog(
      { status: "unavailable", source: "thread/realtime/listVoices", error: "failed" },
      "v3",
    ),
  ).toEqual({ protocol: "v3", choices: [], defaultVoice: null });
});
