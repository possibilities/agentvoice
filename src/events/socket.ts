import { controlSocketPath } from "../control/socket.ts";
import { type JsonPeer, JsonSocketServer } from "../ipc/json-socket.ts";
import { mailboxGetParams, mailboxReplayParams } from "../mailbox/contract.ts";
import { EVENT_PROTOCOL_VERSION, emptyEventParams, eventSubscriptionSchema } from "./contract.ts";
import {
  type ConversationReadMethod,
  type ConversationReadParams,
  conversationCapabilities,
  conversationRequestSchemas,
  ObservationError,
  replayRequestSchema,
} from "./conversation.ts";
import type { LifecycleFeed } from "./feed.ts";

export function eventMatches(patterns: readonly string[], event: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? event.startsWith(pattern.slice(0, -1)) : event === pattern,
  );
}
export class EventSocketServer extends JsonSocketServer {
  private readonly unsubscribe: () => void;
  constructor(
    path: string,
    feed: LifecycleFeed,
    read?: (method: ConversationReadMethod, params: ConversationReadParams) => Promise<unknown>,
  ) {
    const subscribers = new Map<number, { peer: JsonPeer; events: string[] }>();
    super(path, {
      version: EVENT_PROTOCOL_VERSION,
      async handle(request, peer) {
        const respond = (body: object) =>
          peer.send({ v: EVENT_PROTOCOL_VERSION, type: "response", id: request.id, ...body });
        if (request.method === "mailbox.get" || request.method === "mailbox.replay") {
          try {
            const params = (
              request.method === "mailbox.get" ? mailboxGetParams : mailboxReplayParams
            ).safeParse(request.params);
            if (!params.success) throw new ObservationError("invalid_params");
            if (params.data.expectedInstanceId !== feed.snapshot().instanceId)
              throw new ObservationError("instance_mismatch");
            if (request.method === "mailbox.replay") {
              const replay = mailboxReplayParams.parse(params.data);
              respond({ ok: true, result: feed.mailboxReplay(replay.afterSequence, replay.limit) });
            } else respond({ ok: true, result: feed.mailboxSnapshot() });
          } catch (error) {
            const code = error instanceof ObservationError ? error.code : "unavailable";
            respond({ ok: false, error: { code, message: code } });
          }
        } else if (request.method.startsWith("conversation.")) {
          try {
            if (request.method === "conversation.capabilities") {
              if (!emptyEventParams.safeParse(request.params ?? {}).success)
                throw new ObservationError("invalid_params");
              respond({ ok: true, result: conversationCapabilities });
            } else if (request.method === "conversation.replay") {
              const params = replayRequestSchema.safeParse(request.params);
              if (!params.success) throw new ObservationError("invalid_params");
              const snapshot = feed.snapshot();
              if (params.data.expectedInstanceId !== snapshot.instanceId)
                throw new ObservationError("instance_mismatch");
              if (params.data.expectedGeneration !== snapshot.generation)
                throw new ObservationError("stale_generation");
              if (!["ready", "starting"].includes(snapshot.runtime.phase))
                throw new ObservationError("unavailable");
              respond({
                ok: true,
                result: feed.replay(params.data.afterSequence, params.data.limit),
              });
            } else {
              if (!Object.hasOwn(conversationRequestSchemas, request.method)) {
                respond({
                  ok: false,
                  error: { code: "unknown_method", message: "unknown event method" },
                });
                return;
              }
              const method = request.method as ConversationReadMethod;
              const params = conversationRequestSchemas[method].safeParse(request.params);
              if (!params.success) throw new ObservationError("invalid_params");
              if (!read) throw new ObservationError("unavailable");
              respond({ ok: true, result: await read(method, params.data) });
            }
          } catch (error) {
            const code = error instanceof ObservationError ? error.code : "unavailable";
            respond({ ok: false, error: { code, message: code } });
          }
        } else if (!["event.subscribe", "state.get"].includes(request.method)) {
          respond({
            ok: false,
            error: { code: "unknown_method", message: "unknown event method" },
          });
        } else if (request.method === "event.subscribe") {
          const checked = eventSubscriptionSchema.safeParse(request.params ?? {});
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
        } else if (!emptyEventParams.safeParse(request.params ?? {}).success) {
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
