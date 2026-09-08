/**
 * Server mute-state adapter. The client owns capture, playback,
 * codecs, and its RTCPeerConnection, so the controller has no local device to
 * open and no remote track to attach. Mute setters are retained to satisfy the
 * host boundary and can be observed by the browser bridge.
 */

export type MediaStateTarget = "mic" | "speaker";

export interface MediaStateOptions {
  onMute?(target: MediaStateTarget, muted: boolean): void;
}

export class MediaMuteState {
  readonly #options: MediaStateOptions;
  #micMuted = false;
  #speakerMuted = false;

  constructor(options: MediaStateOptions = {}) {
    this.#options = options;
  }

  get micMuted(): boolean {
    return this.#micMuted;
  }

  set micMuted(muted: boolean) {
    if (this.#micMuted === muted) return;
    this.#micMuted = muted;
    this.#options.onMute?.("mic", muted);
  }

  get speakerMuted(): boolean {
    return this.#speakerMuted;
  }

  set speakerMuted(muted: boolean) {
    if (this.#speakerMuted === muted) return;
    this.#speakerMuted = muted;
    this.#options.onMute?.("speaker", muted);
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  attachRemote(_track: unknown): void {}

  detachRemote(): void {}
}
