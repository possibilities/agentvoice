/** Browser media adapter at the existing host factory boundary. */
import type { BrowserMediaClientMessage, BrowserMediaServerMessage } from "../browser/protocol.ts";
import { BrowserVoiceAudio } from "./browser-audio.ts";
import { type BrowserTransportCommand, BrowserVoiceTransport } from "./browser-transport.ts";
import type { ConsoleHostOptions } from "./host.ts";

export function browserMediaAdapter(send: (message: BrowserMediaServerMessage) => void): {
  factory: NonNullable<ConsoleHostOptions["mediaFactory"]>;
  receive(message: BrowserMediaClientMessage): void;
} {
  let transport: BrowserVoiceTransport | undefined;
  const command = (message: BrowserTransportCommand) => {
    send(message);
  };

  return {
    factory: {
      check() {},
      audio: () => new BrowserVoiceAudio(),
      transport: (options) => {
        transport = new BrowserVoiceTransport({ ...options, send: command });
        return transport;
      },
    },
    receive(message) {
      if (message.type === "offer") transport?.handleBrowserOffer(message.sessionId, message.sdp);
      else if (message.type === "connected") transport?.handleBrowserConnected(message.sessionId);
      else if (message.type === "failed")
        transport?.handleBrowserFailed(message.sessionId, message.detail);
      // Mute commands belong to the controller, never the media transport.
    },
  };
}
