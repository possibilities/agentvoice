import { z } from "zod";
import { SocketFailure } from "../ipc/control-client.ts";

const leaf = z.object({
  app: z.string().optional(),
  text: z.string().optional(),
  size: z.number().int().positive().optional(),
  min: z.number().int().positive().optional(),
});
export const layoutSchema = z.object({
  revision: z.number().int(),
  root: z.object({ row: z.array(leaf).length(3) }),
  focus: z.string().nullable(),
  panes: z.array(z.object({ cols: z.number(), rows: z.number() })),
});
export interface MuxControl {
  request(method: string, params?: unknown): Promise<unknown>;
}
export const names = ["client", "voice", "agent"] as const;
export const waiting = "Waiting for voice connection";

export function initialLayout() {
  return {
    root: { row: [{ app: "client" }, { text: waiting }, { text: waiting }] },
    visible: ["client"],
    focus: "client",
  };
}

/** Carry forward divider drags; a rejected revision has made no mutation. */
export async function replacePane(
  mux: MuxControl,
  index: number,
  content: { app: string } | { text: string },
  focus?: string,
) {
  for (let attempts = 0; attempts < 8; attempts++) {
    const layout = layoutSchema.parse(await mux.request("layout.get"));
    const previous = layout.root.row[index]!;
    layout.root.row[index] = { size: previous.size, min: previous.min, ...content };
    const visible = layout.root.row.flatMap((pane) => (pane.app ? [pane.app] : []));
    try {
      return await mux.request("layout.apply", {
        root: layout.root,
        visible,
        revision: layout.revision,
        focus: focus ?? (layout.focus && visible.includes(layout.focus) ? layout.focus : null),
      });
    } catch (error) {
      if (!(error instanceof SocketFailure) || error.code !== "conflict") throw error;
    }
  }
  throw new Error("Layout kept changing while replacing a pane");
}
