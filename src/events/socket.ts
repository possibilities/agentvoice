import { z } from "zod";
import { controlSocketPath } from "../control/socket.ts";
import { type JsonPeer, JsonSocketServer } from "../ipc/json-socket.ts";
import { EVENT_PROTOCOL_VERSION } from "./contract.ts";
import type { LifecycleFeed } from "./feed.ts";

const empty = z.object({}).strict();
const subscription = z
  .object({
    events: z
      .array(
        z
          .string()
          .max(128)
          .regex(/^(?:\*|[a-z][a-z0-9._:/-]*\*?)$/u),
      )
      .min(1)
      .max(32)
      .default(["*"]),
  })
  .strict();
export function eventMatches(patterns: readonly string[], event: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? event.startsWith(pattern.slice(0, -1)) : event === pattern,
  );
}
export class EventSocketServer extends JsonSocketServer {
  private readonly unsubscribe: () => void;
  constructor(path: string, feed: LifecycleFeed) {
    const subscribers = new Map<number, { peer: JsonPeer; events: string[] }>();
    super(path, {
      version: EVENT_PROTOCOL_VERSION,
      handle(request, peer) {
        const respond = (body: object) =>
          peer.send({ v: EVENT_PROTOCOL_VERSION, type: "response", id: request.id, ...body });
        if (!["event.subscribe", "state.get"].includes(request.method)) {
          respond({
            ok: false,
            error: { code: "unknown_method", message: "unknown event method" },
          });
        } else if (request.method === "event.subscribe") {
          const checked = subscription.safeParse(request.params ?? {});
          if (!checked.success) {
            respond({
              ok: false,
              error: {
                code: "invalid_params",
                message: "expected up to 32 exact names or trailing-star prefixes",
              },
            });
            return;
          }
          const events = [...new Set(checked.data.events)];
          // Synchronous handlers and updates share the controller event loop.
          subscribers.set(peer.id, { peer, events });
          respond({ ok: true, result: { subscribed: true, events } });
        } else if (!empty.safeParse(request.params ?? {}).success) {
          respond({
            ok: false,
            error: { code: "invalid_params", message: "expected empty params" },
          });
        } else respond({ ok: true, result: feed.snapshot() });
      },
      closed(peer) {
        subscribers.delete(peer.id);
      },
    });
    this.unsubscribe = feed.listen((event) => {
      for (const subscriber of subscribers.values())
        if (eventMatches(subscriber.events, event.event)) subscriber.peer.send(event);
    });
  }
  override close(): void {
    this.unsubscribe();
    super.close();
  }
}
export function eventSocketPath(stateDir: string, instanceId: string): string {
  return controlSocketPath(stateDir, instanceId).replace(/\.sock$/u, ".events.sock");
}
