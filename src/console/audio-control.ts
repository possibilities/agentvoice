export type AudioTarget = "mic" | "speaker";
export type MuteHoldSource = object | symbol | string | number;

export type AudioControlKeyAction = {
  target: AudioTarget;
  action: "begin" | "renew" | "end" | "toggle";
};
export type PushToTalkKeyAction = "renew" | "end";

export const AUDIO_CONTROL_CLICK_MS = 250;

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

  // Releases close a hold even if the palette opened while the key was down.
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
  /** At least one source currently carries a momentary mute assignment. */
  holding: boolean;
  /** The newest hold's assignment, or the persistent assignment without a hold. */
  effectiveMuted: boolean;
}

/**
 * Persistent mute and ordered momentary assignments are separate so every
 * input source releases only its own hold. The newest active hold wins.
 */
export class MuteGate {
  private mutedValue: boolean;
  private readonly holds = new Map<MuteHoldSource, boolean>();

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
    let effective = this.mutedValue;
    for (const heldMuted of this.holds.values()) effective = heldMuted;
    return effective;
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

  hold(source: MuteHoldSource, muted: boolean): boolean {
    const before = this.state();
    const existing = this.holds.get(source);
    if (existing === muted) return false;
    // Reassigning an existing source is a new override and therefore newest.
    this.holds.delete(source);
    this.holds.set(source, muted);
    return changed(before, this.state());
  }

  release(source: MuteHoldSource, commit = false): boolean {
    const before = this.state();
    const heldMuted = this.holds.get(source);
    if (heldMuted === undefined) return false;
    if (commit) this.mutedValue = heldMuted;
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
