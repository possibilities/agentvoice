import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { browserMediaScript } from "../src/browser/page.ts";

test("media reset retains capture and signaling for a successor; disconnect stops capture", async () => {
  type Listener = (event?: { data: string }) => unknown;
  interface FakeElement {
    listeners: Record<string, Listener>;
    disabled?: boolean;
    textContent?: string;
    addEventListener(name: string, fn: Listener): void;
  }
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        listeners: {},
        addEventListener(name: string, fn: Listener) {
          this.listeners[name] = fn;
        },
      });
    return elements.get(id)!;
  };
  let stopped = false;
  const track = {
    enabled: false,
    stop() {
      stopped = true;
    },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    listeners: Record<string, Listener> = {};
    messages: { sessionId: string }[] = [];
    constructor() {
      sockets.push(this);
    }
    addEventListener(name: string, fn: Listener) {
      this.listeners[name] = fn;
    }
    send(value: string) {
      this.messages.push(JSON.parse(value));
    }
    close() {
      this.readyState = 3;
      this.listeners.close?.();
    }
    async receive(message: unknown) {
      await this.listeners.message?.({ data: JSON.stringify(message) });
    }
  }
  class FakePeer {
    iceGatheringState = "complete";
    localDescription = { sdp: "offer" };
    close() {}
    createDataChannel() {}
    addTrack() {}
    addEventListener() {}
    async createOffer() {
      return this.localDescription;
    }
    async setLocalDescription() {}
  }
  runInNewContext(browserMediaScript, {
    document: { querySelector: element, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    location: { protocol: "http:", host: "127.0.0.1:1234", pathname: "/token/" },
    WebSocket: FakeSocket,
    RTCPeerConnection: FakePeer,
    addEventListener() {},
    setTimeout,
    clearTimeout,
  });
  await element("#start").listeners.click!();
  const socket = sockets[0]!;
  await socket.receive({ type: "prepare", sessionId: "first" });
  await socket.receive({ type: "close", sessionId: "first" });
  expect(stopped).toBe(false);
  expect(socket.readyState).toBe(1);
  await socket.receive({ type: "prepare", sessionId: "second" });
  expect(socket.messages.map((message) => message.sessionId)).toEqual(["first", "second"]);
  socket.close();
  expect(stopped).toBe(true);
  expect(element("#start").disabled).toBe(false);
  expect(element("#status").textContent).toContain("tap Start voice");
});
