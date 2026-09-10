export const soundFamilies = ["off", "rocker-29", "rocker-13"] as const;
export type SoundFamily = (typeof soundFamilies)[number];
export type Sounds = { family: SoundFamily; volumePercent: number };

export function defaultSounds(): Sounds {
  return { family: "off", volumePercent: 70 };
}

export function parseSounds(value: unknown): Sounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid sounds");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 2 || !("family" in data) || !("volumePercent" in data))
    throw Error("Invalid sound fields");
  if (!soundFamilies.includes(data["family"] as SoundFamily)) throw Error("Invalid sound family");
  const volumePercent = data["volumePercent"];
  if (
    typeof volumePercent !== "number" ||
    !Number.isInteger(volumePercent) ||
    volumePercent < 0 ||
    volumePercent > 100
  )
    throw Error("Invalid sound volume");
  return { family: data["family"] as SoundFamily, volumePercent };
}

export function equalSounds(a: Sounds, b: Sounds): boolean {
  return a.family === b.family && a.volumePercent === b.volumePercent;
}
