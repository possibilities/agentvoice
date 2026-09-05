import type { KittyKeyboardOptions } from "@opentui/core";

export type AudioTarget = "mic" | "speaker";
export type UnmuteHoldSource = object | symbol | string | number;

export type AudioControlKeyAction = {
  target: AudioTarget;
  action: "toggle";
};
export type SpaceControlKeyAction = "begin" | "renew" | "end";

// Printable keys need all-keys encoding for terminals to report both halves
// of a press/release gesture, including the Space microphone control.
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
  /** OpenTUI 0.5.3 represents Kitty repeats as press + repeated. */
  repeated?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export function audioControlKeyAction(
  key: ControlKey,
  paletteOpen: boolean,
): AudioControlKeyAction | null {
  const target = key.name === "m" ? "mic" : key.name === "s" ? "speaker" : null;
  if (!target || paletteOpen || key.ctrl || key.meta || key.eventType !== "press" || key.repeated)
    return null;
  return { target, action: "toggle" };
}

export function spaceControlKeyAction(
  key: ControlKey,
  paletteOpen: boolean,
): SpaceControlKeyAction | null {
  if (key.name !== "space" || key.source !== "kitty") return null;
  // A release must close an existing hold even if the palette opened while
  // Space was down; presses belong to the palette while it is modal.
  if (key.eventType === "release") return "end";
  if (paletteOpen || key.ctrl || key.meta) return null;
  if (key.eventType === "repeat" || key.repeated) return "renew";
  return key.eventType === "press" ? "begin" : null;
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

  releaseUnmute(source: UnmuteHoldSource): boolean {
    const before = this.state();
    if (!this.holds.has(source)) return false;
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
