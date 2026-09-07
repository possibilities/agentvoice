export type AudioTarget = "mic" | "speaker";
export type UnmuteHoldSource = object | symbol | string | number;

export interface MuteState {
  /** The persistent mute assignment controlled by pointer clicks. */
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
