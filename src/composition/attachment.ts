import { z } from "zod";
import { AttachmentTranscript } from "../attachment/bridge.ts";
import {
  type AttachmentFrame,
  type AttachmentIdentity,
  sameAttachment,
} from "../attachment/session.ts";
import { attachmentSshArgv } from "../attachment/ssh.ts";
import { voiceViewerArgv } from "../attachment/voice-launcher.ts";
import { appFailure, appSchema } from "./app-exit.ts";
import { attachmentLayout, layoutSchema, type MuxControl, replacePane } from "./layout.ts";

/** Desktop PTYs observing another client's call; this mode creates no voice client. */
export class AttachmentComposition {
  private stopped = false;
  private identity?: AttachmentIdentity;
  private transcript?: AttachmentTranscript;
  private agent = false;
  private message = "Waiting for a call";
  private readonly ended = Promise.withResolvers<void>();
  readonly done = this.ended.promise;
  private failure?: Error;
  constructor(
    private readonly mux: MuxControl,
    private readonly command: string[],
    private readonly host?: string,
  ) {}
  async start() {
    await this.mux.request("instance.configure", { confirmExit: true });
    if (!this.stopped) await this.mux.request("layout.apply", attachmentLayout());
  }
  async receive(frame: AttachmentFrame) {
    if (this.stopped) return;
    if (frame.type === "waiting") {
      if (this.identity) throw new Error("Attachment lost its selected backend");
      return this.placeholder(frame.message);
    }
    if (frame.type === "session") {
      if (this.identity && !sameAttachment(this.identity, frame.identity))
        throw new Error("Backend changed. Run agentvoice --attach again.");
      this.identity = frame.identity;
      if (frame.agentReady && !this.agent) {
        this.agent = true;
        const args = ["__attach-agent", JSON.stringify(frame.identity)];
        await this.create(
          1,
          "agent",
          this.host
            ? attachmentSshArgv(this.host, ["agentvoice", ...args], true)
            : [...this.command, ...args],
        );
      } else if (!this.agent) {
        await this.placeholder(
          frame.phase === "failed" ? "Backend failed · check the server log" : "Starting backend",
        );
      }
      return;
    }
    if (!this.identity) throw new Error("Voice arrived before attachment identity");
    const first = !this.transcript;
    this.transcript ??= new AttachmentTranscript();
    this.transcript.append(frame.line, this.identity);
    if (first) await this.create(0, "voice", voiceViewerArgv(this.transcript.path));
  }
  private async placeholder(message: string) {
    if (message === this.message) return;
    this.message = message;
    if (!this.transcript && !this.stopped)
      await replacePane(this.mux, 0, { text: "Waiting for voice transcript" });
    if (!this.agent && !this.stopped) await replacePane(this.mux, 1, { text: message });
  }
  private async create(index: number, name: string, argv: string[]) {
    if (this.stopped) return;
    const layout = layoutSchema.parse(await this.mux.request("layout.get"));
    if (this.stopped) return;
    const pane = layout.panes[index];
    const app = appSchema.parse(
      await this.mux.request("app.create", {
        name,
        argv,
        cwd: process.cwd(),
        env: {},
        pty: "local",
        whenHidden: "keep",
        cols: Math.max(1, pane?.cols ?? 80),
        rows: Math.max(1, pane?.rows ?? 24),
      }),
    );
    if (app.state !== "running")
      throw appFailure(app) ?? new Error(`${name}: ${app.error ?? app.state}`);
    if (!this.stopped)
      await replacePane(this.mux, index, { app: name }, name === "agent" ? "agent" : undefined);
  }
  event(frame: Record<string, unknown>) {
    if (this.stopped) return;
    if (frame["type"] !== "event") throw new Error("Unexpected smolmux frame");
    if (frame["event"] !== "app.state") return;
    const app = appSchema.parse(z.object({ app: z.unknown() }).parse(frame["data"]).app);
    if (["voice", "agent"].includes(app.name) && ["exited", "failed"].includes(app.state))
      this.stop(appFailure(app));
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
    this.transcript?.close();
  }
}
