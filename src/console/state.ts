import type { ReadyInfo, VoicePhase } from "../core/voice-types.ts";
import type { AudioTarget } from "./audio-control.ts";

export type VoiceInput = "pointer";

export interface VoiceChannelState {
  muted: boolean;
  effectiveMuted: boolean;
}

export interface VoiceState {
  /** False once the foreground host has closed. */
  available: boolean;
  phase: VoicePhase;
  notice?: string;
  workspace?: string;
  conversation?: ReadyInfo;
  mic: VoiceChannelState;
  speaker: VoiceChannelState;
}

export interface VoiceHost {
  state(): VoiceState;
  setMuted(target: AudioTarget, muted: boolean): void;
  beginUnmute(target: AudioTarget, input: VoiceInput): void;
  releaseUnmute(target: AudioTarget, input: VoiceInput): void;
  shutdown(): void | Promise<void>;
}

export interface VoiceView {
  readonly done: Promise<void>;
  refresh(): void;
  cancelInputs(): void;
  shutdown(): Promise<void>;
}
