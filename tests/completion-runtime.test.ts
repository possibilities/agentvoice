import { expect, test } from "bun:test";
import {
  COMPLETION_NAMESPACE,
  COMPLETION_OUTPUT,
  type Completion,
  type CompletionObservation,
  type CompletionRuntime,
} from "../src/completions/contract.ts";
import {
  CONTROL_MCP_SERVER_NAME,
  CONTROL_MCP_TOOLS,
  CONTROL_PROTOCOL_VERSION,
} from "../src/control/types.ts";
import { AppServerError } from "../src/core/attach.ts";
import { VoiceRuntime } from "../src/core/runtime.ts";
import { deferred, runtimeHarness } from "./fixtures/runtime-harness.ts";

const control = {
  name: CONTROL_MCP_SERVER_NAME,
  server: { url: "http://127.0.0.1:1/mcp", required: true },
  tools: CONTROL_MCP_TOOLS,
  env: {},
};

test("runtime sends direct completion metadata with a full working snapshot and deduplicates retries", async () => {
  const observations: CompletionObservation[] = [];
  let completions!: CompletionRuntime;
  const h = runtimeHarness(
    {},
    {
      onCompletion: (event) => observations.push(event),
      onCompletionReady: (runtime) => {
        completions = runtime;
      },
    },
  );
  h.native.override = (method) =>
    method === "thread/loaded/list" ? Promise.resolve({ data: [], nextCursor: null }) : undefined;
  try {
    await h.runtime.start();
    const root = h.runtime.currentReady!.threadId;
    const notify = h.native.options.onNotification;
    notify("turn/started", {
      threadId: root,
      turn: { id: "parent-active", status: "inProgress" },
    });
    for (const id of ["finished-child", "working-child"]) {
      notify("thread/started", {
        thread: {
          id,
          parentThreadId: root,
          cwd: h.directory,
          name: `${id} task`,
          status: { type: "idle" },
        },
      });
      notify("turn/started", { threadId: id, turn: { id: `turn-${id}`, status: "inProgress" } });
    }
    notify("turn/completed", {
      threadId: "finished-child",
      turn: { id: "turn-finished-child", status: "completed", items: [{ text: "PRIVATE_RESULT" }] },
    });
    const completed = observations.find(
      (event): event is Extract<CompletionObservation, { kind: "completed" }> =>
        event.kind === "completed",
    );
    expect(completed?.completion).toMatchObject({
      threadId: "finished-child",
      turnId: "turn-finished-child",
      status: "completed",
    });

    const response = deferred<{ turn: { id: string; status: string } }>();
    let submissions = 0;
    h.native.override = (method, params) => {
      if (method !== "turn/start") return undefined;
      submissions++;
      const tool = params["toolOutput"] as { output: string; name: string; namespace: string };
      const body = JSON.parse(tool.output);
      expect(params).toMatchObject({
        threadId: root,
        input: [],
        turnTrigger: "subagentCompletion",
      });
      expect(tool).toMatchObject({ name: COMPLETION_OUTPUT, namespace: COMPLETION_NAMESPACE });
      expect(body).toMatchObject({
        v: 1,
        type: "subagent.completion",
        eventId: "completion-1",
        instanceId: "instance",
        rootThreadId: root,
        completion: completed!.completion,
        inFlight: {
          complete: true,
          threads: [{ threadId: "working-child", turnId: "turn-working-child" }],
        },
      });
      expect(tool.output).not.toContain("PRIVATE_RESULT");
      return response.promise;
    };
    const request = {
      eventId: "completion-1",
      instanceId: "instance",
      rootThreadId: root,
      completion: completed!.completion,
    };
    const first = completions.deliver(request);
    const retry = completions.deliver(request);
    expect(retry).toBe(first);
    await Bun.sleep(0);
    expect(submissions).toBe(1);
    expect(
      await completions.deliver({
        ...request,
        completion: { ...request.completion, status: "failed" },
      }),
    ).toEqual({ status: "unavailable" });
    response.resolve({ turn: { id: "parent-active", status: "inProgress" } });
    expect(await first).toEqual({ status: "accepted", turnId: "parent-active" });
    expect(await completions.deliver(request)).toEqual({
      status: "accepted",
      turnId: "parent-active",
    });
    expect(submissions).toBe(1);

    expect(
      await completions.deliver({ ...request, eventId: "foreign", rootThreadId: "different" }),
    ).toEqual({ status: "unavailable" });
    h.native.override = (method) =>
      method === "turn/start"
        ? Promise.reject(new AppServerError("private refusal", -32600))
        : undefined;
    expect(await completions.deliver({ ...request, eventId: "refused" })).toEqual({
      status: "refused",
    });
    await h.runtime.shutdown();
    expect(await completions.deliver({ ...request, eventId: "late" })).toEqual({
      status: "unavailable",
    });
  } finally {
    await h.cleanup();
  }
});

test("completion admission submits immediately while a human transcript segment is open", async () => {
  let completions!: CompletionRuntime;
  let completion: Completion | undefined;
  let submissions = 0;
  let submitted: Record<string, unknown> | undefined;
  const h = runtimeHarness(
    {},
    {
      onCompletionReady: (runtime) => {
        completions = runtime;
      },
      onCompletion: (event) => {
        if (event.kind === "completed") completion = event.completion;
      },
    },
  );
  h.native.override = (method, params) => {
    if (method === "thread/loaded/list") return Promise.resolve({ data: [], nextCursor: null });
    if (method === "turn/start" && params["turnTrigger"] === "subagentCompletion") {
      submissions++;
      submitted = params;
      return Promise.resolve({ turn: { id: "completion-turn", status: "inProgress" } });
    }
    return undefined;
  };
  try {
    await h.runtime.start();
    const root = h.runtime.currentReady!.threadId;
    const notify = h.native.options.onNotification;
    const user = {
      id: "human-speaking",
      realtimeSessionId: "realtime",
      type: "transcriptSegment" as const,
      role: "user" as const,
      text: "I am still describing the work",
    };
    notify("thread/realtime/item/started", { threadId: root, item: user });
    notify("thread/started", {
      thread: {
        id: "finished-child",
        parentThreadId: root,
        cwd: h.directory,
        name: "finished child",
        status: { type: "idle" },
      },
    });
    notify("turn/started", {
      threadId: "finished-child",
      turn: { id: "child-turn", status: "inProgress" },
    });
    notify("turn/completed", {
      threadId: "finished-child",
      turn: { id: "child-turn", status: "completed" },
    });
    expect(completion).toBeDefined();

    const pending = completions.deliver({
      eventId: "immediate-completion",
      instanceId: "instance",
      rootThreadId: root,
      completion: completion!,
    });
    await expect(pending).resolves.toEqual({
      status: "accepted",
      turnId: "completion-turn",
    });
    expect(submissions).toBe(1);
    expect(submitted).toMatchObject({ threadId: root, turnTrigger: "subagentCompletion" });
    expect(JSON.parse((submitted!["toolOutput"] as { output: string }).output)).toMatchObject({
      eventId: "immediate-completion",
      completion: completion!,
    });
  } finally {
    await h.cleanup();
  }
});

test("completion delivery remains available while controller MCP readiness is still pending", async () => {
  const readiness = deferred<unknown>();
  let completions: CompletionRuntime | undefined;
  let completion: Completion | undefined;
  const h = runtimeHarness();
  h.native.override = (method) => {
    if (method === "thread/loaded/list") return Promise.resolve({ data: [], nextCursor: null });
    if (method === "mcpServer/tool/call") return readiness.promise;
    return undefined;
  };
  const runtime = new VoiceRuntime(h.config, "test", h.events, {
    ...h.runtimeOptions,
    controlMcp: control,
    onCompletionReady: (api) => {
      completions = api;
    },
    onCompletion: (event) => {
      if (event.kind === "completed") completion = event.completion;
    },
  });
  const startup = runtime.start();
  try {
    while (!completions) await Bun.sleep(0);
    const root = h.native.threads[0]!.id;
    const notify = h.native.options.onNotification;
    notify("thread/started", {
      thread: {
        id: "startup-child",
        parentThreadId: root,
        cwd: h.directory,
        name: "startup task",
        status: { type: "idle" },
      },
    });
    notify("turn/completed", {
      threadId: "startup-child",
      turn: { id: "startup-turn", status: "completed" },
    });
    expect(completion).toBeDefined();
    await expect(
      completions.deliver({
        eventId: "during-startup",
        instanceId: "instance",
        rootThreadId: root,
        completion: completion!,
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    readiness.resolve({
      isError: false,
      structuredContent: {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        instanceId: "instance",
        workspace: h.directory,
        threadId: root,
        generation: 1,
        runtime: { phase: "starting" },
        recentOperations: [],
      },
    });
    await startup;
  } finally {
    readiness.resolve({});
    await runtime.shutdown();
    await h.cleanup();
  }
});
