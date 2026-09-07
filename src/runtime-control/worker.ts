/** Internal disposable worker. Never launch directly; parent IPC is its authority. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentTicket } from "../attachment/gateway.ts";
import type { ConsoleHostOptions } from "../console/host.ts";
import type { VoiceHost, VoiceState } from "../console/state.ts";
import type { ServerConfig } from "../core/config.ts";
import { type HandoffRequest, type HandoffResult, handoffFailure } from "../core/handoff.ts";
import type { RuntimeSnapshot } from "../core/runtime.ts";
import type { ThreadInventory } from "../events/contract.ts";
import {
  type ConversationReadMethod,
  conversationRequestSchemas,
  ObservationError,
} from "../events/conversation.ts";
import { ipcMessage, type RuntimeActivation, type RuntimeLaunch } from "./protocol.ts";
import { runtimeSender } from "./sender.ts";

export function runRuntimeWorker(
  dependencies: { mediaFactory?: ConsoleHostOptions["mediaFactory"] } = {},
): void {
  const generation = Number(process.argv[2]);
  if (!process.send || !Number.isSafeInteger(generation))
    throw new Error("Runtime requires its controller IPC");
  let launch: RuntimeLaunch | undefined;
  let config: ServerConfig | undefined;
  let snapshot: RuntimeSnapshot | undefined;
  let factory: ConsoleHostOptions["mediaFactory"];
  let runHost: typeof import("../console/host.ts").runConsoleHost;
  let host: (VoiceHost & { redial(): Promise<void> }) | undefined;
  let submitHandoff: ((request: HandoffRequest) => Promise<HandoffResult>) | undefined;
  let revokeAttachment: (() => void) | undefined;
  let issueAttachment: (() => AttachmentTicket) | undefined;
  let readConversation:
    | Parameters<NonNullable<ConsoleHostOptions["onObservationReady"]>>[0]
    | undefined;
  let hostRun: Promise<void> | undefined;
  let endHost: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let forced = false;
  let stopping = false;
  let starting = false;
  let bootReady: (() => void) | undefined;
  let bootFailed: ((error: Error) => void) | undefined;
  let mediaStarted = false;
  let mediaEnabled = false;
  let terminalFailure = false;
  let desiredMute = { mic: true, speaker: true };
  let threadInventory: ThreadInventory | undefined;
  let next = 1;
  const leases = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();

  function redact(message: string): string {
    for (const secret of Object.values(launch?.control.env ?? {})) {
      if (secret) message = message.replaceAll(secret, "[redacted]");
    }
    return message;
  }
  const sender = runtimeSender({
    generation,
    connected: () => process.connected,
    write: (message, done) => {
      process.send?.(message, done);
    },
    failed: () => {
      if (!stopping) void shutdown().finally(() => process.exit(1));
    },
  });
  const send = sender.send;
  function event(method: string, params?: unknown) {
    send({ method, params });
  }
  function acquireLease(threadId: string): Promise<void> {
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        leases.delete(id);
        reject(new Error("Controller lease request timed out"));
      }, 10_000);
      leases.set(id, { resolve, reject, timer });
      send({ id, method: "lease", params: { threadId } });
    });
  }
  function fingerprint(): string {
    const hash = createHash("sha256");
    if (process.argv[1]) hash.update(readFileSync(process.argv[1]));
    const root = new URL("../../", import.meta.url).pathname;
    function walk(directory: string): void {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          hash.update(path.slice(root.length));
          hash.update(readFileSync(path));
        }
      }
    }
    walk(join(root, "src"));
    walk(join(root, "build", "native", `${process.platform}-${process.arch}`));
    return hash.digest("hex");
  }
  async function preflight(params: RuntimeLaunch) {
    if (launch) throw new Error("Runtime preflight already completed");
    const before = fingerprint();
    launch = params;
    const [{ loadLaunchConfig }, runtime, media] = await Promise.all([
      import("../core/launch-config.ts"),
      import("../core/runtime.ts"),
      import("../console/host.ts"),
    ]);
    config = await loadLaunchConfig(params.provenance.parsed, params.provenance.launchCwd);
    if (params.workspace && config.orchestrator.workspace !== params.workspace)
      throw new Error(
        "Reload would change the pinned workspace; use a separate launch to change context",
      );
    snapshot = await runtime.prepareRuntime(config, params.control);
    factory = dependencies.mediaFactory ?? (await media.nativeMediaFactory());
    factory.check(); // Loads and pins the native library without opening hardware.
    runHost = media.runConsoleHost;
    const after = fingerprint();
    if (before !== after)
      throw new Error(
        "Runtime code/native artifact changed during preflight; retry after the build finishes",
      );
    return { workspace: config.orchestrator.workspace, pid: process.pid, buildId: after };
  }
  let lastState = "";
  function publish() {
    if (!host || stopping || terminalFailure) return;
    if (threadInventory && sender.pending < 16) {
      event("threads", threadInventory);
      threadInventory = undefined;
    }
    const state: VoiceState = host.state();
    if (state.notice) state.notice = redact(state.notice);
    const serialized = JSON.stringify(state);
    if (serialized !== lastState) {
      lastState = serialized;
      event("state", state);
    }
    if (mediaStarted && state.phase === "live") bootReady?.();
    if (state.phase === "failed")
      bootFailed?.(new Error(state.notice ?? "Voice connection failed"));
  }
  async function activate(params: RuntimeActivation): Promise<void> {
    if (!config || !snapshot || !launch || !factory || starting)
      throw new Error("Runtime is not an unused prepared candidate");
    starting = true;
    desiredMute = params.mute;
    const currentLaunch = launch;
    await new Promise<void>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(deadline);
        bootReady = undefined;
        bootFailed = undefined;
        if (error) reject(error);
        else resolve();
      };
      bootReady = () => finish();
      bootFailed = finish;
      hostRun = runHost(config!, currentLaunch.version, {
        onHandoffReady: (submit) => {
          submitHandoff = submit;
        },
        onObservationReady: (read) => {
          readConversation = read;
        },
        mediaFactory: factory,
        media: currentLaunch.provenance.options,
        debug: currentLaunch.provenance.options.debug,
        initialMute: { mic: true, speaker: true },
        runtime: {
          fresh: params.threadId ? false : currentLaunch.provenance.options.fresh,
          continue: params.threadId ? false : currentLaunch.provenance.options.continue,
          resume: params.threadId ? undefined : currentLaunch.provenance.options.resume,
          exactResume: params.threadId,
          fast: currentLaunch.provenance.parsed.fast,
          snapshot,
          nativeStateDir: currentLaunch.nativeStateDir,
          onAttachmentReady: (issue, revoke) => {
            issueAttachment = issue;
            revokeAttachment = revoke;
          },
          controlMcp: currentLaunch.control,
          acquireLease,
          onVerifiedThread: (identity) => event("identity", identity),
          onThreads: (inventory) => {
            threadInventory = inventory;
            publish();
          },
          onVoice: (notification) => {
            if (!stopping && !terminalFailure) event("voice", notification);
          },
          onConversation: (notification) => {
            if (!stopping && !terminalFailure) event("conversation", notification);
          },
          onChildPid: (pid) => event("native-pid", { pid }),
          onShutdownOutcome: (value) => {
            forced = value;
          },
          onChildReaped: () => event("native-reaped"),
        },
        onStarted: () => {
          mediaStarted = true;
          deadline = setTimeout(
            () => finish(new Error("Voice connection did not become live within 35 seconds")),
            35_000,
          );
          publish();
        },
        observe: async (bindings) => {
          host = bindings;
          const done = new Promise<void>((finish) => {
            endHost = finish;
          });
          tick = setInterval(publish, 100);
          return {
            done,
            refresh: publish,
            cancelInputs() {},
            shutdown: async () => {
              endHost?.();
            },
          };
        },
      });
      void hostRun.then(
        () => {
          terminalFailure = true;
          clearInterval(tick);
          finish(new Error("Runtime stopped during startup"));
          if (!stopping) event("fatal", { message: "Runtime stopped" });
        },
        (error) => {
          terminalFailure = true;
          clearInterval(tick);
          finish(error instanceof Error ? error : new Error(String(error)));
          if (!stopping) event("fatal", { message: redact(String(error)) });
        },
      );
    });
  }
  async function shutdown() {
    stopping = true;
    revokeAttachment?.();
    clearInterval(tick);
    await host?.shutdown();
    endHost?.();
    await hostRun?.catch(() => {});
    return { forced };
  }
  async function command(method: string, params: unknown): Promise<unknown> {
    if (Object.hasOwn(conversationRequestSchemas, method)) {
      const key = method as ConversationReadMethod;
      const parsed = conversationRequestSchemas[key].safeParse(params);
      if (!parsed.success) return { ok: false, error: { code: "invalid_params" } };
      if (stopping || terminalFailure || !readConversation)
        return { ok: false, error: { code: "unavailable" } };
      try {
        return { ok: true, result: await readConversation(key, parsed.data) };
      } catch (error) {
        return {
          ok: false,
          error: { code: error instanceof ObservationError ? error.code : "unavailable" },
        };
      }
    }
    switch (method) {
      case "preflight":
        return preflight(params as RuntimeLaunch);
      case "activate":
        return activate(params as RuntimeActivation);
      case "shutdown":
        return shutdown();
      case "mute":
      case "enable-media": {
        desiredMute = params as { mic: boolean; speaker: boolean };
        if (method === "enable-media") {
          if (terminalFailure || stopping || !mediaStarted || host?.state().phase !== "live")
            throw new Error("Cannot enable media on a runtime that is not live");
          mediaEnabled = true;
        }
        if (mediaEnabled) {
          host?.setMuted("mic", desiredMute.mic);
          host?.setMuted("speaker", desiredMute.speaker);
        }
        return null;
      }
      case "redial":
        if (terminalFailure || stopping || !mediaEnabled || !host)
          throw new Error("Voice redial is unavailable");
        await host.redial();
        return null;
      case "handoff":
        if (terminalFailure || stopping || !mediaEnabled || !submitHandoff)
          return handoffFailure("not_ready");
        return submitHandoff(params as HandoffRequest);
      case "attachment-ticket": {
        if (terminalFailure || stopping || !mediaEnabled || !issueAttachment)
          throw new Error("Attachment is unavailable");
        const ticket = issueAttachment();
        if (ticket.threadId !== (params as { threadId?: string })?.threadId)
          throw new Error("Attachment thread changed");
        return ticket;
      }
      default:
        throw new Error("Unknown runtime command");
    }
  }
  process.on("message", (value) => {
    if (!ipcMessage(value, generation)) {
      void shutdown().finally(() => process.exit(1));
      return;
    }
    if (!value.method && value.id) {
      const pending = leases.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      leases.delete(value.id);
      if (value.error) pending.reject(new Error(value.error));
      else pending.resolve();
      return;
    }
    if (!value.method) return;
    void command(value.method, value.params).then(
      (result) => {
        if (value.id) send({ id: value.id, result: result ?? null });
        if (value.method === "shutdown") setTimeout(() => process.exit(0), 25);
      },
      (error) => {
        if (value.id)
          send({
            id: value.id,
            error: redact(error instanceof Error ? error.message : String(error)),
          });
      },
    );
  });
  process.on("disconnect", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}
if (import.meta.main) runRuntimeWorker();
