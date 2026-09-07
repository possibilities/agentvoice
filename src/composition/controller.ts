import { z } from "zod";
import type { FrontendObservation } from "../frontend/protocol.ts";
import {
  CompositionLayout,
  initialLayout,
  layoutSchema,
  type MuxControl,
  names,
  stageSchema,
} from "./layout.ts";
import { type MessagePresence, openVoiceMessages } from "./messages.ts";

const appSchema = z.object({
  name: z.string(),
  state: z.string(),
  error: z.string().nullable().optional(),
});

export class Composition {
  private stopped = false;
  private attached?: { workspace: string; threadId: string };
  private agentAttached = false;
  private messages?: MessagePresence;
  private poll?: ReturnType<typeof setTimeout>;
  private layout = new CompositionLayout();
  private started = false;
  private state?: FrontendObservation;
  private tail = Promise.resolve();
  private readonly ended = Promise.withResolvers<void>();
  readonly done = this.ended.promise;
  private failure?: Error;
  constructor(
    private readonly mux: MuxControl,
    private readonly clientId: string,
    private readonly command: string[],
    private readonly workspace?: string,
    private readonly openMessages = openVoiceMessages,
  ) {}

  private enqueue(action: () => Promise<void>) {
    this.tail = this.tail
      .then(async () => {
        if (!this.stopped) await action();
      })
      .catch((error) => this.stop(error instanceof Error ? error : new Error(String(error))));
  }
  async start() {
    await this.mux.request("instance.configure", { confirmExit: true });
    if (this.stopped) return;
    const { stage } = z.object({ stage: stageSchema }).parse(await this.mux.request("layout.get"));
    if (this.stopped) return;
    this.layout = new CompositionLayout(stage.cols);
    await this.mux.request("layout.apply", initialLayout(stage.cols));
    await this.create(0, ["client", ...(this.workspace ? ["--workspace", this.workspace] : [])], {
      AGENTVOICE_CLIENT_ID: this.clientId,
    });
    this.started = true;
    this.enqueue(() => this.reconcile());
  }
  observe(state: FrontendObservation) {
    this.state = state;
    if (state.clientId === this.clientId && !state.state && this.attached) this.stop();
    if (this.started) this.enqueue(() => this.reconcile());
  }
  event(frame: Record<string, unknown>) {
    if (frame["type"] !== "event") throw new Error("Unexpected smolmux frame");
    if (frame["event"] === "layout.changed") {
      const data = z.object({ cause: z.string() }).parse(frame["data"]);
      if (data.cause === "resize" && this.started) this.enqueue(() => this.reconcile());
      return;
    }
    if (frame["event"] !== "app.state") return;
    const app = appSchema.parse(z.object({ app: z.unknown() }).parse(frame["data"]).app);
    if (!["exited", "failed"].includes(app.state)) return;
    if (!names.includes(app.name as (typeof names)[number])) return;
    this.stop(
      app.state === "failed" ? new Error(app.error ?? `${app.name} app failed`) : undefined,
    );
  }
  private async create(index: number, args: string[], env: Record<string, string> = {}) {
    if (this.stopped) return;
    const layout = layoutSchema.parse(await this.mux.request("layout.get"));
    if (this.stopped) return;
    const pane = layout.panes[index === 2 ? layout.panes.length - 1 : index];
    const cols =
      layout.root.row.length === 2 && index < 2
        ? Math.floor(((layout.panes[0]?.cols ?? 80) - 1) / 2)
        : (pane?.cols ?? 80);
    const app = appSchema.parse(
      await this.mux.request("app.create", {
        name: names[index],
        argv: [...this.command, ...args],
        cwd: process.cwd(),
        env,
        pty: "local",
        whenHidden: "keep",
        cols: Math.max(1, cols),
        rows: Math.max(1, pane?.rows ?? 24),
      }),
    );
    if (app.state !== "running") throw new Error(`${names[index]}: ${app.error ?? app.state}`);
  }
  private async reconcile() {
    const state = this.state;
    const disconnected = {
      connected: false,
      agent: this.agentAttached,
      placeholder:
        state?.clientId === this.clientId && state.state?.phase === "failed"
          ? "Voice connection failed"
          : undefined,
    };
    if (
      !state ||
      state.clientId !== this.clientId ||
      !state.busy ||
      !state.workspace ||
      !state.threadId
    ) {
      await this.layout.update(this.mux, disconnected);
      return;
    }
    if (
      this.attached &&
      (this.attached.workspace !== state.workspace || this.attached.threadId !== state.threadId)
    )
      throw new Error("Voice call identity changed; reopen the composition");
    if (!state.state?.available || state.state.phase !== "live") {
      await this.layout.update(this.mux, disconnected);
      return;
    }
    const selection = ["--workspace", state.workspace, "--thread", state.threadId];
    if (!this.attached) {
      this.attached = { workspace: state.workspace, threadId: state.threadId };
      if (this.stopped) return;
      await this.create(1, ["attach", "voice", ...selection]);
      if (this.stopped) return;
      this.messages = this.openMessages(state.workspace, state.threadId);
    }
    await this.layout.update(this.mux, { connected: true, agent: this.agentAttached });
    if (this.stopped || this.agentAttached) return;
    if (this.messages!.hasMessages()) {
      await this.create(2, ["attach", "agent", ...selection]);
      if (this.stopped) return;
      this.agentAttached = true;
      await this.layout.update(this.mux, { connected: true, agent: true });
      this.messages!.close();
      clearTimeout(this.poll);
    } else {
      this.poll ??= setTimeout(() => {
        this.poll = undefined;
        this.enqueue(() => this.reconcile());
      }, 100);
    }
  }
  stop(error?: Error) {
    this.failure ??= error;
    this.stopped = true;
    clearTimeout(this.poll);
    this.messages?.close();
    this.ended.resolve();
  }
  error() {
    return this.failure;
  }
  async drained() {
    await this.tail;
  }
}
