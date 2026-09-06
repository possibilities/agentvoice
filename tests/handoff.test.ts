import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConsoleHost } from "../src/console/host.ts";
import { AppServerError } from "../src/core/attach.ts";
import {
  type HandoffRequest,
  type HandoffResult,
  handoffPromptSchema,
} from "../src/core/handoff.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";
import { hostHarness } from "./fixtures/host-harness.ts";
import { deferred, runtimeHarness } from "./fixtures/runtime-harness.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

describe("native restart handoff", () => {
  test("byte bounds preserve exact whitespace and Unicode content", () => {
    for (const prompt of ["a".repeat(8192), `${"雪".repeat(2730)}ab`, "\n Task 雪 \n"])
      expect(handoffPromptSchema.parse(prompt)).toBe(prompt);
    for (const prompt of ["", " \n\t", "a".repeat(8193), "雪".repeat(2731), null])
      expect(handoffPromptSchema.safeParse(prompt).success).toBe(false);
  });

  test("native task input preserves default prompts and refuses stale/Fresh/shutdown targets", async () => {
    const h = runtimeHarness();
    const input: HandoffRequest = {
      prompt: "Check status.\n雪",
      workspace: h.directory,
      threadId: "thread-1",
      clientUserMessageId: "correlation",
    };
    try {
      expect((await h.runtime.submitHandoff(input)).status).toBe("failed");
      await h.runtime.start();
      expect(await h.runtime.submitHandoff(input)).toEqual({
        status: "accepted",
        turnId: "turn-1",
      });
      expect(h.native.calls.find((call) => call.method === "turn/start")?.params).toEqual({
        threadId: input.threadId,
        clientUserMessageId: input.clientUserMessageId,
        input: [
          {
            type: "text",
            text: `AgentVoice restart handoff (agent-provided task):\n\n${input.prompt}`,
          },
        ],
      });
      expect(h.native.calls[1]?.params).not.toHaveProperty("developerInstructions");
      expect((await h.runtime.submitHandoff({ ...input, workspace: "/foreign" })).status).toBe(
        "failed",
      );
      const gate = deferred<unknown>();
      h.native.override = (method) => (method === "thread/start" ? gate.promise : undefined);
      const fresh = h.runtime.fresh();
      expect((await h.runtime.submitHandoff(input)).status).toBe("failed");
      gate.resolve({
        thread: { id: "new-thread" },
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      });
      await fresh;
      expect((await h.runtime.submitHandoff(input)).status).toBe("failed");
      await h.runtime.shutdown();
      expect((await h.runtime.submitHandoff({ ...input, threadId: "new-thread" })).status).toBe(
        "failed",
      );
      expect(h.native.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("explicit refusal, timeout, malformed success and transport loss never echo native error text or close the runtime", async () => {
    const h = runtimeHarness();
    try {
      await h.runtime.start();
      const input = {
        prompt: "PRIVATE CONTENT",
        workspace: h.directory,
        threadId: "thread-1",
        clientUserMessageId: "correlation",
      };
      const outcomes: Array<[() => Promise<unknown>, HandoffResult["status"]]> = [
        [() => Promise.reject(new AppServerError(input.prompt, -32600)), "failed"],
        [() => Promise.reject(new AppServerError(input.prompt, undefined, true)), "unknown"],
        [() => Promise.reject(new Error(input.prompt)), "unknown"],
        [() => Promise.resolve({ turn: {} }), "unknown"],
        [() => Promise.resolve(null), "unknown"],
      ];
      for (const [response, status] of outcomes) {
        h.native.override = (method) => (method === "turn/start" ? response() : undefined);
        const result = await h.runtime.submitHandoff(input);
        expect(result.status).toBe(status);
        expect(JSON.stringify(result)).not.toContain(input.prompt);
        expect(h.native.alive).toBe(true);
        expect(h.fatal).toEqual([]);
      }
    } finally {
      await h.cleanup();
    }
  });

  test("private native handoff frames and echoed errors are omitted from debug logs", async () => {
    const h = runtimeHarness();
    const debug: string[] = [];
    h.events.debug = (line) => debug.push(line);
    try {
      await h.runtime.start();
      const prompt = 'private "quoted"\n雪';
      h.native.override = (method, params) => {
        if (method !== "turn/start") return undefined;
        h.native.options.debug?.(`-> ${JSON.stringify(params)}`);
        h.native.options.debug?.(`<- ${JSON.stringify({ error: { message: prompt } })}`);
        return Promise.resolve({ turn: { id: "native", status: "inProgress" } });
      };
      await h.runtime.submitHandoff({
        prompt,
        workspace: h.directory,
        threadId: "thread-1",
        clientUserMessageId: "correlation",
      });
      expect(debug).toEqual([
        "[restart handoff content omitted]",
        "[restart handoff content omitted]",
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("host only delivers with live media and refuses after signal failure or shutdown", async () => {
    const h = hostHarness();
    const done = deferred();
    const live = deferred();
    let submit!: (request: HandoffRequest) => Promise<HandoffResult>;
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      onHandoffReady: (callback) => {
        submit = callback;
      },
      onStarted: () => live.resolve(),
      createTui: async () => ({
        done: done.promise,
        refresh() {},
        cancelInputs() {},
        shutdown: async () => {
          done.resolve();
        },
      }),
    });
    const input = {
      prompt: "Task",
      workspace: h.directory,
      threadId: "thread-1",
      clientUserMessageId: "correlation",
    };
    try {
      expect((await submit(input)).status).toBe("failed");
      await live.promise;
      expect((await submit(input)).status).toBe("accepted");
      h.failTransport("offline");
      expect((await submit(input)).status).toBe("failed");
      done.resolve();
      await run;
      expect((await submit(input)).status).toBe("failed");
      expect(h.native.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    } finally {
      done.resolve();
      await run;
      await h.cleanup();
    }
  });
});

function controllerHarness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-handoff-")));
  const calls: Array<{ generation: number; method: string; params: unknown }> = [];
  const stopped: number[] = [];
  const callbacks: Array<(method: string, params: unknown) => void> = [];
  const options: {
    gate?: Promise<void>;
    failPreflight?: boolean;
    handoff?: () => Promise<unknown>;
    changed?: () => void;
  } = {};
  const controller = new RuntimeController({
    instanceId: "handoff",
    stateDir: root,
    version: "test",
    provenance: {
      parsed: parseArgs([]),
      options: { debug: false, fresh: false, continue: false },
      launchCwd: root,
    },
    control: { name: "agentvoice_control", tools: [], server: {}, env: {} },
    lease: () => () => {},
    changed: () => options.changed?.(),
    spawn: (generation, event, lease) => {
      callbacks.push(event);
      return {
        pid: generation,
        nativePid: undefined,
        exited: Promise.resolve(),
        notify() {},
        stop: async () => {
          stopped.push(generation);
          return false;
        },
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ generation, method, params });
          if (method === "preflight") {
            if (options.failPreflight) throw new Error("preflight failed");
            return { workspace: root, pid: generation, buildId: "fixture" } as T;
          }
          if (method === "activate") {
            await lease("saved");
            event("identity", { workspace: root, threadId: "saved" });
          }
          if (method === "enable-media" && generation > 1) await options.gate;
          if (method === "handoff")
            return (await (options.handoff?.() ??
              Promise.resolve({ status: "accepted", turnId: "native" }))) as T;
          return null as T;
        },
      };
    },
  });
  const request = (id: string, prompt: string | undefined = "PRIVATE TASK") => ({
    operationId: id,
    scope: "runtime" as const,
    expectedInstanceId: "handoff",
    expectedGeneration: controller.status().generation,
    handoffPrompt: prompt,
  });
  return {
    root,
    calls,
    stopped,
    callbacks,
    options,
    controller,
    request,
    cleanup: async () => {
      await controller.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("controller handoff consumption", () => {
  test("journals privately before acceptance, waits for media, pins identity and deduplicates changed/omitted requests", async () => {
    const h = controllerHarness();
    const gate = deferred();
    h.options.gate = gate.promise;
    try {
      await h.controller.start();
      const request = h.request("one");
      const accepted = await h.controller.restart(request);
      const journal = join(h.root, "operations/handoff.jsonl");
      expect(readFileSync(journal, "utf8")).toContain("PRIVATE TASK");
      expect(statSync(journal).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(accepted)).not.toContain("PRIVATE TASK");
      await until(() =>
        h.calls.some((call) => call.generation === 2 && call.method === "enable-media"),
      );
      h.callbacks[0]!("identity", { workspace: "/foreign", threadId: "foreign" });
      await h.controller.fresh();
      expect(h.calls.some((call) => call.method === "fresh" || call.method === "handoff")).toBe(
        false,
      );
      expect(h.controller.status().threadId).toBe("saved");
      for (const handoffPrompt of [undefined, "different"])
        await expect(h.controller.restart({ ...request, handoffPrompt })).rejects.toThrow(
          "different immutable request",
        );
      expect((await h.controller.restart(request)).handoff?.status).toBe("pending");
      gate.resolve();
      await until(() => h.controller.status().currentOperation?.handoff?.status === "accepted");
      expect(h.calls.filter((call) => call.method === "handoff")).toEqual([
        {
          generation: 2,
          method: "handoff",
          params: {
            prompt: "PRIVATE TASK",
            workspace: h.root,
            threadId: "saved",
            clientUserMessageId: accepted.handoff!.clientUserMessageId,
          },
        },
      ]);
      await h.controller.restart(request);
      expect(h.calls.filter((call) => call.method === "handoff")).toHaveLength(1);
      expect(JSON.stringify(h.controller.status())).not.toContain("PRIVATE TASK");
      await h.controller.redial({
        operationId: "redial",
        expectedGeneration: 2,
        expectedInstanceId: "handoff",
      });
      await until(
        () =>
          h.controller.status().currentOperation?.operationId === "redial" &&
          h.controller.status().currentOperation?.phase === "ready",
      );
      expect(h.calls.filter((call) => call.method === "handoff")).toHaveLength(1);
      const noPrompt = { ...h.request("omitted"), handoffPrompt: undefined };
      await h.controller.restart(noPrompt);
      await until(() => h.controller.status().currentOperation?.phase === "ready");
      await expect(h.controller.restart({ ...noPrompt, handoffPrompt: "added" })).rejects.toThrow(
        "different immutable request",
      );
      expect(h.calls.filter((call) => call.method === "handoff")).toHaveLength(1);
    } finally {
      gate.resolve();
      await h.cleanup();
    }
  });

  for (const mode of ["refused", "timeout", "malformed"] as const) {
    test(`${mode} handoff leaves the runtime ready and never retries on late readiness`, async () => {
      const h = controllerHarness();
      h.options.handoff = async () => {
        if (mode === "timeout") throw new Error("PRIVATE TASK");
        if (mode === "malformed") return { unexpected: "PRIVATE TASK" };
        return {
          status: "failed",
          error: { code: "native_refused", message: "PRIVATE TASK" },
        };
      };
      try {
        await h.controller.start();
        const request = h.request(mode);
        await h.controller.restart(request);
        await until(() =>
          ["failed", "unknown"].includes(
            h.controller.status().currentOperation?.handoff?.status ?? "",
          ),
        );
        expect(h.controller.status().runtime.phase).toBe("ready");
        expect(h.controller.status().currentOperation?.phase).toBe("ready");
        expect(h.stopped).toEqual([1]);
        h.callbacks[1]!("identity", { workspace: h.root, threadId: "saved" });
        await h.controller.restart(request);
        expect(h.calls.filter((call) => call.method === "handoff")).toHaveLength(1);
        expect(JSON.stringify(h.controller.status())).not.toContain("PRIVATE TASK");
      } finally {
        await h.cleanup();
      }
    });
  }

  for (const boundary of ["preflight", "shutdown", "shutdown-on-submitting"] as const) {
    test(`${boundary} does not submit a delayed handoff`, async () => {
      const h = controllerHarness();
      try {
        await h.controller.start();
        if (boundary === "preflight") h.options.failPreflight = true;
        if (boundary === "shutdown-on-submitting")
          h.options.changed = () => {
            if (h.controller.status().currentOperation?.handoff?.status === "submitting")
              void h.controller.shutdown();
          };
        await h.controller.restart(h.request(boundary));
        if (boundary === "shutdown") await h.controller.shutdown();
        await until(() => h.controller.status().currentOperation?.handoff?.status === "failed");
        expect(h.calls.some((call) => call.method === "handoff")).toBe(false);
        if (boundary === "preflight") {
          expect(h.controller.status().runtime.phase).toBe("ready");
          expect(h.stopped).toEqual([2]);
        }
      } finally {
        await h.cleanup();
      }
    });
  }
});
