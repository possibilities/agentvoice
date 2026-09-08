import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { browserMediaScript } from "../src/browser/page.ts";

type Input = {
  data?: string;
  pointerId?: number;
  button?: number;
  isPrimary?: boolean;
  code?: string;
  repeat?: boolean;
  preventDefault?: () => void;
};
type Listener = (event: Input) => unknown;
function harness() {
  class Element {
    disabled = false;
    value = "local";
    textContent = "";
    listeners: Record<string, Listener> = {};
    addEventListener(name: string, listener: Listener) {
      this.listeners[name] = listener;
    }
    setPointerCapture() {}
    emit(name: string, event: Input = {}) {
      return this.listeners[name]?.(event);
    }
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const track = {
    enabled: false,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let permission: () => Promise<typeof stream> = async () => stream;
  const sockets: FakeSocket[] = [];
  class FakeSocket extends Element {
    static OPEN = 1;
    readyState = 1;
    messages: Array<{ type: string; sessionId: string }> = [];
    constructor(readonly url: string) {
      super();
      sockets.push(this);
    }
    send(data: string) {
      this.messages.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    receive(value: unknown) {
      return this.emit("message", { data: JSON.stringify(value) });
    }
  }
  const peers: FakePeer[] = [];
  class FakePeer extends Element {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription = { sdp: "offer" };
    constructor() {
      super();
      peers.push(this);
    }
    close() {}
    createDataChannel() {}
    addTrack() {}
    async createOffer() {
      return this.localDescription;
    }
    async setLocalDescription() {}
    connect() {
      this.connectionState = "connected";
      this.emit("connectionstatechange");
    }
  }
  const document = Object.assign(new Element(), { querySelector: element, hidden: false });
  const window = new Element();
  runInNewContext(browserMediaScript, {
    document,
    navigator: { mediaDevices: { getUserMedia: () => permission() } },
    location: { protocol: "http:", host: "127.0.0.1:1234", pathname: "/token/" },
    WebSocket: FakeSocket,
    RTCPeerConnection: FakePeer,
    addEventListener: window.addEventListener.bind(window),
    setTimeout,
    clearTimeout,
  });
  return {
    element,
    track,
    stream,
    sockets,
    peers,
    document,
    window,
    permission: (next: typeof permission) => {
      permission = next;
    },
    start: async () => {
      await element("#start").emit("click");
      const socket = sockets.at(-1)!;
      await socket.receive({ type: "prepare", sessionId: "session" });
      peers.at(-1)!.connect();
      return socket;
    },
  };
}
const pointer = (id = 1): Input => ({
  pointerId: id,
  button: 0,
  isPrimary: true,
  preventDefault() {},
});
const state = (muted: boolean, effectiveMuted = muted) => ({
  type: "state",
  sessionId: "session",
  mic: { muted, effectiveMuted },
  speaker: { muted: true, effectiveMuted: true },
});

test("PTT stays present, waits for server permission and remutes immediately on release or cancellation", async () => {
  const h = harness();
  const socket = await h.start();
  const hold = h.element("#hold");
  await socket.receive(state(false));
  expect(hold.disabled).toBe(true);
  await socket.receive(state(true));
  expect(hold.disabled).toBe(false);
  for (const ending of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    hold.emit("pointerdown", pointer());
    expect(socket.messages.at(-1)?.type).toBe("hold");
    expect(h.track.enabled).toBe(false);
    await socket.receive(state(true, false));
    expect(h.track.enabled).toBe(true);
    hold.emit(ending, pointer());
    expect(socket.messages.at(-1)?.type).toBe("release");
    expect(h.track.enabled).toBe(false);
    await socket.receive(state(true, false));
    expect(h.track.enabled).toBe(false); // A late unmute acknowledgement cannot reopen capture.
    expect(hold.textContent).toBe("Hold to talk");
  }
  expect("hidden" in hold).toBe(false);
  socket.close();
});

test("PTT ignores secondary pointers, releases on blur/background, and supports held keyboard activation", async () => {
  const h = harness();
  const socket = await h.start();
  const hold = h.element("#hold");
  await socket.receive(state(true));
  hold.emit("pointerdown", pointer());
  hold.emit("pointerup", pointer(2));
  expect(socket.messages.at(-1)?.type).toBe("hold");
  h.window.emit("blur");
  expect(socket.messages.at(-1)?.type).toBe("release");
  hold.emit("pointerdown", pointer());
  h.document.hidden = true;
  h.document.emit("visibilitychange");
  expect(socket.messages.at(-1)?.type).toBe("release");
  hold.emit("keydown", { code: "Space", preventDefault() {} });
  expect(socket.messages.at(-1)?.type).toBe("hold");
  hold.emit("keyup", { code: "Space", preventDefault() {} });
  expect(socket.messages.at(-1)?.type).toBe("release");
  socket.close();
});

test("server switching stops old media, fences late socket events and only reconnects on explicit Start", async () => {
  const h = harness();
  const local = await h.start();
  expect(local.url).toEndWith("?server=local");
  h.element("#server").value = "remote";
  h.element("#server").emit("change");
  expect(local.readyState).toBe(3);
  expect(h.track.stopped).toBe(true);
  expect(h.sockets).toHaveLength(1);
  expect(h.element("#start").disabled).toBe(false);
  const remote = await h.start();
  expect(remote.url).toEndWith("?server=remote");
  local.emit("close");
  expect(remote.readyState).toBe(1);
  remote.close();
});

test("switching while microphone permission is pending stops the late capture without opening a call", async () => {
  const h = harness();
  const pending = Promise.withResolvers<typeof h.stream>();
  h.permission(() => pending.promise);
  const start = h.element("#start").emit("click");
  h.element("#server").emit("change");
  pending.resolve(h.stream);
  await start;
  expect(h.track.stopped).toBe(true);
  expect(h.sockets).toHaveLength(0);
});
