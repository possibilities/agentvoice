import type { KittyKeyboardOptions } from "@opentui/core";

export type AudioTarget = "mic" | "speaker";
export type UnmuteHoldSource = object | symbol | string | number;

export type AudioControlKeyAction = {
  target: AudioTarget;
  action: "begin" | "renew" | "end" | "toggle";
};
export type PushToTalkKeyAction = "renew" | "end";

export const AUDIO_CONTROL_CLICK_MS = 250;

// Printable keys need all-keys encoding for terminals to report both halves
// of a press/release gesture, including the dedicated Space hold.
export const AUDIO_CONTROL_KITTY_KEYBOARD = {
  events: true,
  allKeysAsEscapes: true,
} satisfies KittyKeyboardOptions;

// Long enough to span the terminal's initial key-repeat delay; repeats renew
// it, while a lost release still fails closed.
export const KEY_HOLD_LEASE_MS = 3_000;

interface ControlKey {
  name: string;
  source: "raw" | "kitty";
  eventType: "press" | "repeat" | "release";
}

export function audioControlKeyAction(
  key: ControlKey,
  paletteOpen: boolean,
): AudioControlKeyAction | null {
  const target = key.name === "m" ? "mic" : key.name === "s" ? "speaker" : null;
  if (!target) return null;

  // Releases finish a gesture even if the palette opened while the key was down.
  if (key.source === "kitty" && key.eventType === "release") {
    return { target, action: "end" };
  }
  if (paletteOpen) return null;
  if (key.source === "raw") {
    return key.eventType === "press" ? { target, action: "toggle" } : null;
  }
  if (key.eventType === "press") return { target, action: "begin" };
  if (key.eventType === "repeat") return { target, action: "renew" };
  return null;
}

export function pushToTalkKeyAction(
  key: ControlKey,
  paletteOpen: boolean,
): PushToTalkKeyAction | null {
  if (key.name !== "space" || key.source !== "kitty") return null;
  // A release must close an existing hold even if the palette opened while
  // Space was down; presses belong to the palette while it is modal.
  if (key.eventType === "release") return "end";
  if (paletteOpen) return null;
  return key.eventType === "press" || key.eventType === "repeat" ? "renew" : null;
}

export function releaseCommitsClick(startedAt: number, releasedAt: number): boolean {
  return releasedAt - startedAt <= AUDIO_CONTROL_CLICK_MS;
}

export interface MuteState {
  /** The persistent mute assignment controlled by clicks and palette actions. */
  muted: boolean;
  /** At least one source is momentarily opening a persistently muted channel. */
  holding: boolean;
  /** The assignment currently applied after active unmute holds. */
  effectiveMuted: boolean;
}

/**
 * Persistent mute and momentary unmute holds are separate so every input
 * source releases only its own hold. The last release closes the channel.
 */
export class MuteGate {
  private mutedValue: boolean;
  private readonly holds = new Set<UnmuteHoldSource>();

  constructor(muted = false) {
    this.mutedValue = muted;
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  get holding(): boolean {
    return this.holds.size > 0;
  }

  get effectiveMuted(): boolean {
    return this.mutedValue && !this.holding;
  }

  state(): MuteState {
    return {
      muted: this.muted,
      holding: this.holding,
      effectiveMuted: this.effectiveMuted,
    };
  }

  setMuted(muted: boolean): boolean {
    const before = this.state();
    this.mutedValue = muted;
    return changed(before, this.state());
  }

  beginUnmute(source: UnmuteHoldSource): boolean {
    if (!this.mutedValue) return false;
    const before = this.state();
    this.holds.add(source);
    return changed(before, this.state());
  }

  releaseUnmute(source: UnmuteHoldSource, commit = false): boolean {
    const before = this.state();
    if (!this.holds.has(source)) return false;
    if (commit) this.mutedValue = false;
    this.holds.delete(source);
    return changed(before, this.state());
  }
}

function changed(before: MuteState, after: MuteState): boolean {
  return (
    before.muted !== after.muted ||
    before.holding !== after.holding ||
    before.effectiveMuted !== after.effectiveMuted
  );
}
