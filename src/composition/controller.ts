import { z } from "zod";
import type { FrontendObservation } from "../frontend/protocol.ts";
import { initialLayout, layoutSchema, type MuxControl, names, replacePane } from "./layout.ts";

const appSchema = z.object({
  name: z.string(),
  state: z.string(),
  error: z.string().nullable().optional(),
});

export class Composition {
  private stopped = false;
  private attached = false;
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
  ) {}

  private enqueue(action: () => Promise<void>) {
    this.tail = this.tail
      .then(async () => {
        if (!this.stopped) await action();
      })
      .catch((error) => this.stop(error instanceof Error ? error : new Error(String(error))));
  }
  async start() {
    await this.mux.request("layout.apply", initialLayout());
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
    if (frame["event"] !== "app.state") return;
    const app = appSchema.parse(z.object({ app: z.unknown() }).parse(frame["data"]).app);
    if (!["exited", "failed"].includes(app.state)) return;
    if (app.name === "client") {
      this.stop(app.state === "failed" ? new Error(app.error ?? "Voice client failed") : undefined);
      return;
    }
    const index = names.indexOf(app.name as (typeof names)[number]);
    if (index > 0)
      this.enqueue(async () => {
        await replacePane(this.mux, index, {
          text: `${app.name === "voice" ? "Voice transcript" : "Agent"} disconnected`,
        });
      });
  }
  private async create(index: number, args: string[], env: Record<string, string> = {}) {
    if (this.stopped) return;
    const layout = layoutSchema.parse(await this.mux.request("layout.get"));
    if (this.stopped) return;
    const pane = layout.panes[index];
    const app = appSchema.parse(
      await this.mux.request("app.create", {
        name: names[index],
        argv: [...this.command, ...args],
        cwd: process.cwd(),
        env,
        pty: "local",
        whenHidden: "keep",
        cols: Math.max(1, pane?.cols ?? 80),
        rows: Math.max(1, pane?.rows ?? 24),
      }),
    );
    if (app.state !== "running") throw new Error(`${names[index]}: ${app.error ?? app.state}`);
  }
  private async reconcile() {
    const state = this.state;
    if (
      this.attached ||
      !state ||
      state.clientId !== this.clientId ||
      !state.busy ||
      !state.state?.available ||
      state.state.phase !== "live" ||
      !state.workspace ||
      !state.threadId
    )
      return;
    this.attached = true;
    const selection = ["--workspace", state.workspace, "--thread", state.threadId];
    for (const index of [1, 2]) {
      if (this.stopped) return;
      await this.create(index, ["attach", names[index]!, ...selection]);
      if (this.stopped) return;
      await replacePane(this.mux, index, { app: names[index]! }, index === 2 ? "agent" : undefined);
    }
  }
  stop(error?: Error) {
    this.failure ??= error;
    this.stopped = true;
    this.ended.resolve();
  }
  error() {
    return this.failure;
  }
  async drained() {
    await this.tail;
  }
}
