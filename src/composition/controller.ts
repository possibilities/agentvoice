import { z } from "zod";
import type { FrontendObservation } from "../frontend/protocol.ts";
import { appFailure, appSchema } from "./app-exit.ts";
import { initialLayout, layoutSchema, type MuxControl, names, replacePane } from "./layout.ts";

export class Composition {
  private stopped = false;
  private attached = false;
  private generation = 0;
  private replacing = false;
  private readonly restarting = new Set<string>();
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
    private readonly clientArgs: string[] = [],
    private readonly refreshObservation?: () => Promise<FrontendObservation>,
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
    await this.mux.request("layout.apply", initialLayout());
    await this.create(
      0,
      ["client", ...this.clientArgs, ...(this.workspace ? ["--workspace", this.workspace] : [])],
      {
        AGENTVOICE_CLIENT_ID: this.clientId,
      },
    );
    this.started = true;
    this.enqueue(() => this.reconcile());
  }
  observe(state: FrontendObservation) {
    this.state = state;
    if (
      state.clientId === this.clientId &&
      this.attached &&
      (state.generation ?? 1) > this.generation
    )
      this.replacing = true;
    if (state.clientId === this.clientId && !state.state && this.attached) this.stop();
    if (this.started) this.enqueue(() => this.reconcile());
  }
  event(frame: Record<string, unknown>) {
    if (this.stopped) return;
    if (frame["type"] !== "event") throw new Error("Unexpected smolmux frame");
    if (frame["event"] !== "app.state") return;
    const app = appSchema.parse(z.object({ app: z.unknown() }).parse(frame["data"]).app);
    if (!["exited", "failed"].includes(app.state)) return;
    if (!names.includes(app.name as (typeof names)[number])) return;
    if (app.name !== "client" && (this.replacing || this.restarting.has(app.name))) return;
    if (app.name !== "client" && this.attached && this.refreshObservation) {
      this.enqueue(async () => {
        this.observe(await this.refreshObservation!());
        if (!this.replacing) this.stop(appFailure(app));
      });
      return;
    }
    this.stop(appFailure(app));
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
    if (app.state !== "running")
      throw appFailure(app) ?? new Error(`${names[index]}: ${app.error ?? app.state}`);
  }
  private async reconcile() {
    const state = this.state;
    if (
      (this.attached && !this.replacing) ||
      !state ||
      state.clientId !== this.clientId ||
      !state.busy ||
      !state.state?.available ||
      state.state.phase !== "live" ||
      !state.workspace ||
      !state.threadId
    )
      return;
    const replacement = this.attached;
    this.attached = true;
    this.generation = state.generation ?? 1;
    const selection = ["--workspace", state.workspace, "--thread", state.threadId];
    for (const index of [1, 2]) {
      if (this.stopped) return;
      const name = names[index]!;
      if (replacement) {
        this.restarting.add(name);
        try {
          const app = appSchema.parse(
            await this.mux.request("app.restart", {
              name,
              command: {
                argv: [...this.command, "attach", name, ...selection],
                cwd: process.cwd(),
                env: {},
              },
            }),
          );
          if (app.state !== "running") throw appFailure(app) ?? new Error(`${name}: ${app.state}`);
        } finally {
          this.restarting.delete(name);
        }
      } else await this.create(index, ["attach", name, ...selection]);
      if (this.stopped) return;
      await replacePane(this.mux, index, { app: names[index]! }, index === 2 ? "agent" : undefined);
    }
    if (replacement) {
      const { apps } = z
        .object({ apps: z.array(appSchema) })
        .parse(await this.mux.request("app.list"));
      for (const name of ["voice", "agent"]) {
        const app = apps.find((app) => app.name === name);
        if (app?.state !== "running")
          throw (
            (app && appFailure(app)) ?? new Error(`${name} attachment exited during replacement`)
          );
      }
    }
    this.replacing = (this.state?.generation ?? 1) > this.generation;
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
