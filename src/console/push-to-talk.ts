export type PushToTalkSource = object | symbol | string | number;
export type PushToTalkKeyAction = "renew" | "end";

// Long enough to span the terminal's initial key-repeat delay; repeats renew
// it, while a lost release still fails closed.
export const PUSH_TO_TALK_KEY_LEASE_MS = 3_000;

export function pushToTalkKeyAction(
  key: {
    name: string;
    source: "raw" | "kitty";
    eventType: "press" | "repeat" | "release";
  },
  paletteOpen: boolean,
): PushToTalkKeyAction | null {
  if (key.name !== "space" || key.source !== "kitty") return null;
  // A release must close an existing hold even if the palette opened while
  // Space was down; presses belong to the palette while it is modal.
  if (key.eventType === "release") return "end";
  if (paletteOpen) return null;
  return key.eventType === "press" || key.eventType === "repeat" ? "renew" : null;
}

export interface PushToTalkState {
  /** The persistent mute assignment controlled by M and Remote consoles. */
  muted: boolean;
  /** At least one hold is momentarily opening an otherwise muted microphone. */
  talking: boolean;
  /** The value applied to the Duplex audio device's silent-frame gate. */
  effectiveMuted: boolean;
}

/**
 * Persistent mute and momentary holds are separate so concurrent input
 * sources cannot release one another's push-to-talk hold.
 */
export class PushToTalkGate {
  private mutedValue: boolean;
  private readonly holds = new Set<PushToTalkSource>();

  constructor(muted = false) {
    this.mutedValue = muted;
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  get talking(): boolean {
    return this.holds.size > 0;
  }

  get effectiveMuted(): boolean {
    return this.mutedValue && !this.talking;
  }

  state(): PushToTalkState {
    return {
      muted: this.muted,
      talking: this.talking,
      effectiveMuted: this.effectiveMuted,
    };
  }

  setMuted(muted: boolean): boolean {
    const before = this.state();
    this.mutedValue = muted;
    // A persistent unmute supersedes every temporary hold. Otherwise a later
    // mute could revive a hold whose key or pointer was already released.
    if (!muted) this.holds.clear();
    return changed(before, this.state());
  }

  begin(source: PushToTalkSource): boolean {
    if (!this.mutedValue) return false;
    const wasTalking = this.talking;
    this.holds.add(source);
    return wasTalking !== this.talking;
  }

  end(source: PushToTalkSource): boolean {
    const wasTalking = this.talking;
    this.holds.delete(source);
    return wasTalking !== this.talking;
  }
}

function changed(before: PushToTalkState, after: PushToTalkState): boolean {
  return (
    before.muted !== after.muted ||
    before.talking !== after.talking ||
    before.effectiveMuted !== after.effectiveMuted
  );
}
