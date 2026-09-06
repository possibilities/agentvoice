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
      "Fleet NDJSON event contract: event.subscribe and state.get, correlated responses, and named typed events. Lifecycle events reconcile by snapshot watermark; transient voice events never do. Filtering, ordering, byte limits and delivery semantics are documented in docs/events.md.",
  };
}
if (import.meta.main) {
  const path = new URL("../events.schema.json", import.meta.url);
  await Bun.write(path, `${JSON.stringify(buildEventsSchema(), null, 2)}\n`);
  console.log(`wrote ${path.pathname}`);
}
