/** Server signaling adapter: both native and browser clients own their media. */
import type { ClientMediaMessage, ServerMediaMessage } from "../frontend/media-protocol.ts";
import { ClientMediaSession, type ClientSessionCommand } from "./client-session.ts";
import type { ConsoleHostOptions } from "./host.ts";
import { MediaMuteState } from "./media-state.ts";

export function clientMediaAdapter(send: (message: ServerMediaMessage) => void): {
  factory: NonNullable<ConsoleHostOptions["mediaFactory"]>;
  receive(message: ClientMediaMessage): void;
} {
  let transport: ClientMediaSession | undefined;
  const command = (message: ClientSessionCommand) => {
    send(message);
  };

  return {
    factory: {
      check() {},
      audio: () => new MediaMuteState(),
      transport: (options) => {
        transport = new ClientMediaSession({ ...options, send: command });
        return transport;
      },
    },
    receive(message) {
      if (message.type === "offer") transport?.handleClientOffer(message.sessionId, message.sdp);
      else if (message.type === "connected") transport?.handleClientConnected(message.sessionId);
      else if (message.type === "failed")
        transport?.handleClientFailed(message.sessionId, message.detail);
      // Mute commands belong to the controller, never the media transport.
    },
  };
}
