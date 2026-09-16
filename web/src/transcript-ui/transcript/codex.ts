import { type CodexTransportOptions, fetchThread, fetchThreadItems } from "../lib/api/codex.ts";
import type { TranscriptSource } from "./types.ts";

export type { CodexTransportOptions } from "../lib/api/codex.ts";
export { parseCodexMessagePresentation } from "../lib/api/codex-presentation.ts";
export {
  type CodexSubagentActivityPresentation,
  mapCodexSubagentActivity,
} from "../lib/api/codex-subagent-activity.ts";

/** Map the existing reader HTTP API to portable transcript data. No database access. */
export function createCodexTranscriptSource(options: CodexTransportOptions = {}): TranscriptSource {
  return {
    async load({ id, signal }) {
      const view = await fetchThread(id, signal, options);
      return {
        id: view.thread.id,
        title: view.thread.title,
        messages: view.thread.messages,
        cursor: String(view.latestOrdinal),
        status: view.status,
      };
    },
    async poll({ id, cursor, signal }) {
      const ordinal = Number(cursor);
      if (!/^-?\d+$/.test(cursor) || !Number.isSafeInteger(ordinal) || ordinal < -1) {
        throw new Error("Invalid transcript cursor");
      }
      const update = await fetchThreadItems(id, ordinal, signal, options);
      return {
        messages: update.messages,
        cursor: String(update.latestOrdinal),
        status: update.status,
      };
    },
  };
}
