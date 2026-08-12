import { unwatchFile, watchFile } from "node:fs";
import { ConfigError, type RealtimeVersion, type ServerConfig } from "./config.ts";

const LEGACY_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

const V3_VOICES = [
  "arbor",
  "breeze",
  "cove",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
] as const;

const VOICES_BY_VERSION: Record<RealtimeVersion, ReadonlySet<string>> = {
  v1: new Set(LEGACY_VOICES),
  v2: new Set(LEGACY_VOICES),
  v3: new Set(V3_VOICES),
};

/** Build only the config view consumed by the replacement realtime session. */
export function configWithVoiceName(config: ServerConfig, name: string | undefined): ServerConfig {
  if (name === config.voice.name) return config;
  return { ...config, voice: { ...config.voice, name } };
}

export interface WatchedConfigSource {
  path: string;
  load(): Promise<ServerConfig>;
}

export interface ConfigWatchEffects {
  voiceNameChanged(name: string | undefined): void;
  rejected(error: unknown): void;
}

function validateVoiceName(name: string | undefined, version: RealtimeVersion): void {
  if (name === undefined) return;
  const supported = VOICES_BY_VERSION[version];
  if (!supported.has(name)) {
    throw new ConfigError(
      `voice.name must be one of ${[...supported].join(", ")} for ${version}; got "${name}"`,
    );
  }
}

/**
 * Watches the config file but reacts only to voice.name. Each future reactive
 * key must get its own comparison, validation, and component-specific effect.
 */
export class ConfigWatcher {
  private voiceName: string | undefined;
  private loading = false;
  private reloadPending = false;
  private watching = false;

  constructor(
    private readonly source: WatchedConfigSource,
    initialConfig: ServerConfig,
    private readonly effects: ConfigWatchEffects,
  ) {
    this.voiceName = initialConfig.voice.name;
    this.voiceVersion = initialConfig.voice.version;
  }

  private readonly voiceVersion: RealtimeVersion;

  private readonly listener = (): void => {
    void this.reload();
  };

  start(): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.source.path, { interval: 250 }, this.listener);
  }

  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    unwatchFile(this.source.path, this.listener);
  }

  async reload(): Promise<void> {
    if (this.loading) {
      this.reloadPending = true;
      return;
    }
    this.loading = true;
    do {
      this.reloadPending = false;
      try {
        const next = await this.source.load();
        this.applyVoiceName(next.voice.name);
      } catch (error) {
        this.effects.rejected(error);
      }
    } while (this.reloadPending);
    this.loading = false;
  }

  private applyVoiceName(next: string | undefined): void {
    if (next === this.voiceName) return;
    validateVoiceName(next, this.voiceVersion);
    this.voiceName = next;
    this.effects.voiceNameChanged(next);
  }
}
