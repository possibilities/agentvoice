import { z } from "zod";
import { SocketFailure } from "../ipc/control-client.ts";

const leaf = z.object({
  app: z.string().optional(),
  text: z.string().optional(),
  size: z.number().int().positive().optional(),
  min: z.number().int().positive().optional(),
});
export const stageSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const layoutSchema = z.object({
  revision: z.number().int(),
  root: z.object({ row: z.array(leaf).min(2).max(3) }),
  focus: z.string().nullable(),
  stage: stageSchema,
  panes: z.array(z.object({ cols: z.number(), rows: z.number() })),
});
export interface MuxControl {
  request(method: string, params?: unknown): Promise<unknown>;
}
export const names = ["client", "voice", "agent"] as const;
export const waiting = "Waiting for voice connection";
export const waitingMessages = "Waiting for voice messages…";

export function initialLayout(cols: number) {
  const available = Math.max(0, cols - 2);
  const left = Math.max(1, available - Math.floor(available / 3) + 1);
  return {
    root: { row: [{ text: waiting, size: left }, { text: waitingMessages }] },
    visible: [] as string[],
    focus: null as string | null,
  };
}

/** The combined left area splits only for live media. Drags survive either transition. */
export class CompositionLayout {
  private left: [z.infer<typeof leaf>, z.infer<typeof leaf>] = [{}, {}];
  private fraction = 0.5;
  constructor(private columns?: number) {}

  async update(
    mux: MuxControl,
    state: { connected: boolean; agent: boolean; placeholder?: string },
  ) {
    for (let attempts = 0; attempts < 8; attempts++) {
      const layout = layoutSchema.parse(await mux.request("layout.get"));
      const resized = this.columns !== undefined && this.columns !== layout.stage.cols;
      const current = layout.root.row.map((pane) => ({ ...pane }));
      if (resized) {
        const before = Math.max(1, this.columns! - current.length + 1);
        const after = Math.max(1, layout.stage.cols - current.length + 1);
        for (const pane of current) {
          if (pane.size !== undefined)
            pane.size = Math.max(1, Math.round((pane.size * after) / before));
        }
      }
      this.columns ??= layout.stage.cols;
      const right = current.at(-1)!;
      const showingAgent = right.app === "agent";
      const placeholder = state.placeholder ?? waiting;
      if (
        !resized &&
        (current.length === 3) === state.connected &&
        showingAgent === state.agent &&
        (state.connected || current[0]!.text === placeholder)
      )
        return;
      let row = current.slice();
      let left = this.left;
      let fraction = this.fraction;
      if (state.connected && current.length === 2) {
        const combined = resized ? current[0]!.size : layout.panes[0]?.cols;
        const available = Math.max(2, (combined ?? current[0]!.size ?? 2) - 1);
        const client = Math.max(1, Math.min(available - 1, Math.round(available * fraction)));
        row = [
          { ...left[0], app: "client", size: client },
          { ...left[1], app: "voice", size: available - client },
          right,
        ];
      } else if (!state.connected && current.length === 3) {
        left = [current[0]!, current[1]!];
        const client = (resized ? current[0]!.size : layout.panes[0]?.cols) ?? 0;
        const voice = (resized ? current[1]!.size : layout.panes[1]?.cols) ?? 0;
        if (client > 0 && voice > 0) fraction = client / (client + voice);
        row = [
          {
            text: placeholder,
            size: Math.max(1, client + voice + Number(client > 0 && voice > 0)),
          },
          right,
        ];
      }
      if (!state.connected) row[0] = { ...row[0]!, text: placeholder };
      row[row.length - 1] = {
        size: right.size,
        min: right.min,
        ...(state.agent ? { app: "agent" } : { text: waitingMessages }),
      };
      const visible = row.flatMap((pane) => (pane.app ? [pane.app] : []));
      const focus =
        state.agent && !showingAgent
          ? "agent"
          : layout.focus && visible.includes(layout.focus)
            ? layout.focus
            : state.connected
              ? "client"
              : null;
      try {
        await mux.request("layout.apply", {
          root: { row },
          visible,
          revision: layout.revision,
          focus,
        });
        this.left = left;
        this.fraction = fraction;
        this.columns = layout.stage.cols;
        return;
      } catch (error) {
        if (!(error instanceof SocketFailure) || error.code !== "conflict") throw error;
        // A newer drag owns its cell sizes, even during a terminal resize.
        this.columns = layout.stage.cols;
      }
    }
    throw new Error("Layout kept changing while replacing a placeholder");
  }
}
