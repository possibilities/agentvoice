import { z } from "zod";
import { eventSocketFrameSchema } from "../src/events/schema.ts";

export function buildEventsSchema() {
  return {
    ...z.toJSONSchema(eventSocketFrameSchema, {
      target: "draft-2020-12",
      io: "input",
      reused: "ref",
    }),
    title: "AgentVoice event socket",
    description:
      "Protocol 2 fleet NDJSON event contract: lifecycle/voice events and typed conversation observation, live snapshots, bounded replay and scoped native history pages. Lifecycle and conversation snapshots have separate watermarks; voice events are never replayed. See docs/events.md and docs/conversations.md.",
  };
}
if (import.meta.main) {
  const path = new URL("../events.schema.json", import.meta.url);
  await Bun.write(path, `${JSON.stringify(buildEventsSchema(), null, 2)}\n`);
  console.log(`wrote ${path.pathname}`);
}
