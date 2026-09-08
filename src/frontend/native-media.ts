import type { MediaStreamTrack } from "werift";
import type { HostAudio, MediaOptions } from "../console/host.ts";
import type { ClientMediaMessage, ServerMediaMessage } from "./media-protocol.ts";
import type { MediaPeer, PeerEvents } from "./native-peer.ts";
import type { FrontendState } from "./protocol.ts";

export interface ClientMediaDependencies {
  audio(send: (frame: Buffer) => void): HostAudio;
  peer(events: PeerEvents): MediaPeer;
}
type Session = {
  id: string;
  peer: MediaPeer;
  track?: MediaStreamTrack;
  timer: ReturnType<typeof setTimeout>;
};

/** One call-owned device, at most two peers; shutdown fences every async completion. */
export class NativeClientMedia {
  private readonly audio: HostAudio;
  private readonly sessions = new Map<string, Session>();
  private current?: string;
  private live?: Session;
  private stopped = false;
  private started?: Promise<void>;
  private shutdown?: Promise<void>;
  private readonly closing = new Set<Promise<void>>();
  constructor(
    private readonly dependencies: ClientMediaDependencies,
    private readonly send: (message: ClientMediaMessage) => void,
  ) {
    this.audio = dependencies.audio((frame) => this.live?.peer.send(frame));
    this.audio.micMuted = true;
    this.audio.speakerMuted = true;
  }
  state(state: Pick<FrontendState, "mic" | "speaker">): void {
    this.audio.micMuted = this.stopped || state.mic.effectiveMuted;
    this.audio.speakerMuted = this.stopped || state.speaker.effectiveMuted;
  }
  async receive(message: ServerMediaMessage): Promise<void> {
    if (this.stopped) return;
    if (message.type === "prepare") {
      if (this.sessions.has(message.sessionId)) return;
      this.current = message.sessionId;
      for (const session of this.sessions.values()) {
        if (session !== this.live) this.drop(session);
      }
      const id = message.sessionId;
      let session: Session;
      const peer = this.dependencies.peer({
        connected: () => {
          if (this.stopped || this.sessions.get(id) !== session || this.current !== id) return;
          clearTimeout(session.timer);
          const old = this.live;
          this.live = session;
          this.audio.detachRemote();
          if (session.track) this.audio.attachRemote(session.track);
          if (old && old !== session) this.drop(old);
          this.send({ type: "connected", sessionId: id });
        },
        failed: () => this.fail(id, "WebRTC connection failed"),
        track: (track) => {
          if (this.stopped || this.sessions.get(id) !== session) return;
          session.track = track;
          if (this.live === session) this.audio.attachRemote(track);
        },
      });
      session = {
        id,
        peer,
        timer: setTimeout(() => this.fail(id, "Media negotiation timed out"), 25_000),
      };
      this.sessions.set(id, session);
      try {
        this.started ??= this.audio.start();
        await this.started;
        if (this.stopped || this.sessions.get(id) !== session) return;
        const sdp = await peer.offer();
        if (!this.stopped && this.sessions.get(id) === session)
          this.send({ type: "offer", sessionId: id, sdp });
      } catch {
        this.fail(id, "Unable to start client microphone or WebRTC");
      }
    } else if (message.type === "answer") {
      const session = this.sessions.get(message.sessionId);
      if (!session) return;
      try {
        await session.peer.answer(message.sdp);
      } catch {
        this.fail(session.id, "Unable to apply media answer");
      }
    } else if (message.type === "close") {
      const session = this.sessions.get(message.sessionId);
      if (session) this.drop(session);
    } else if (message.sessionId === this.current) this.state(message);
  }
  private fail(id: string, detail: string): void {
    const session = this.sessions.get(id);
    if (this.stopped || !session) return;
    this.drop(session);
    this.send({ type: "failed", sessionId: id, detail });
  }
  private drop(session: Session): void {
    this.sessions.delete(session.id);
    clearTimeout(session.timer);
    if (this.live === session) {
      this.live = undefined;
      this.audio.detachRemote();
    }
    const closing = session.peer.close();
    this.closing.add(closing);
    void closing.catch(() => {}).finally(() => this.closing.delete(closing));
  }
  stop(): Promise<void> {
    this.shutdown ??= (async () => {
      this.stopped = true;
      this.audio.micMuted = true;
      this.audio.speakerMuted = true;
      for (const session of this.sessions.values()) this.drop(session);
      await this.started?.catch(() => {});
      try {
        await this.audio.stop();
      } finally {
        await Promise.allSettled(this.closing);
      }
    })();
    return this.shutdown;
  }
}

export async function nativeClientMedia(
  send: (message: ClientMediaMessage) => void,
  options: MediaOptions = {},
): Promise<NativeClientMedia> {
  const [{ DuplexVoiceAudio }, { duplexAudioAvailabilityError }, { nativePeer }] =
    await Promise.all([
      import("../console/duplex-audio.ts"),
      import("../console/duplex-device.ts"),
      import("./native-peer.ts"),
    ]);
  const error = duplexAudioAvailabilityError();
  if (error) throw new Error(error);
  return new NativeClientMedia(
    {
      audio: (sendFrame) =>
        new DuplexVoiceAudio({ ...options, sendFrame, onWarning: console.error }),
      peer: nativePeer,
    },
    send,
  );
}
