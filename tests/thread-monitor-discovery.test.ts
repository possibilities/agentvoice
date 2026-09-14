import { expect, test } from "bun:test";

test("read-only discovery retries only compatible legacy status protocols and keeps exact selection", async () => {
  const { discoverObservedController } = await import("../src/threads/monitor.ts");
  const calls: unknown[][] = [];
  const fixture = { status: { instanceId: "instance" } } as Awaited<
    ReturnType<typeof discoverObservedController>
  >;
  const result = await discoverObservedController(
    "/fixture/state",
    "/fixture/workspace",
    "root",
    async (...args) => {
      calls.push(args);
      if (args[3] !== 5) throw new Error("no live AgentVoice controller for fixture");
      return fixture;
    },
  );
  expect(result).toBe(fixture);
  expect(calls).toEqual([
    ["/fixture/state", "/fixture/workspace", "root", undefined],
    ["/fixture/state", "/fixture/workspace", "root", 6],
    ["/fixture/state", "/fixture/workspace", "root", 5],
  ]);
  let count = 0;
  await expect(
    discoverObservedController("/fixture/state", "/fixture/workspace", "root", async () => {
      count++;
      throw new Error("ambiguous controller");
    }),
  ).rejects.toThrow("ambiguous");
  expect(count).toBe(1);
});
test("read-only compatibility discovery checks every protocol and rejects mixed-runtime ambiguity", async () => {
  const { discoverObservedController } = await import("../src/threads/monitor.ts");
  const candidate = (instanceId: string, generation = 1) =>
    ({
      status: { instanceId, generation, workspace: "/fixture/workspace", threadId: "root" },
    }) as Awaited<ReturnType<typeof discoverObservedController>>;
  const versions: (number | undefined)[] = [];
  await expect(
    discoverObservedController(
      "/fixture/state",
      "/fixture/workspace",
      "root",
      async (_state, _workspace, _thread, version) => {
        versions.push(version);
        if (version === 5) throw new Error("no live AgentVoice controller");
        return candidate(version === 6 ? "legacy" : "current");
      },
    ),
  ).rejects.toThrow("ambiguous");
  expect(versions).toEqual([undefined, 6, 5]);
  const same = candidate("same");
  let probes = 0;
  expect(
    await discoverObservedController("/fixture/state", "/fixture/workspace", "root", async () => {
      probes++;
      return same;
    }),
  ).toBe(same);
  expect(probes).toBe(3);
  await expect(
    discoverObservedController(
      "/fixture/state",
      "/fixture/workspace",
      "root",
      async (_state, _workspace, _thread, version) => candidate("same", version === 6 ? 2 : 1),
    ),
  ).rejects.toThrow("ambiguous");
});
