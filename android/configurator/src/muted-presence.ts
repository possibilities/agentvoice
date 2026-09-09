export const mutedTuningBounds = {
  textSizeSp: [12, 32],
  brightnessPercent: [0, 100],
  driftPercent: [0, 300],
  breathPercent: [0, 100],
  cycleSeconds: [6, 30],
} as const;
export type MutedTuningAmount = keyof typeof mutedTuningBounds;
export const mutedTuningAmounts = Object.keys(mutedTuningBounds) as MutedTuningAmount[];
export const mutedMotions = ["float", "ripple"] as const;
export type MutedMotion = (typeof mutedMotions)[number];
export type MutedTuning = Record<MutedTuningAmount, number> & { motion: MutedMotion };
export type MutedTuningField = keyof MutedTuning;
export const mutedTuningFields: MutedTuningField[] = [...mutedTuningAmounts, "motion"];
export function defaultMutedTuning(): MutedTuning {
  return {
    textSizeSp: 14,
    brightnessPercent: 0,
    driftPercent: 100,
    breathPercent: 0,
    cycleSeconds: 14,
    motion: "float",
  };
}
export function parseMutedTuning(value: unknown): MutedTuning {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid muted tuning");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== mutedTuningFields.length)
    throw Error("Invalid muted tuning fields");
  for (const field of mutedTuningAmounts) {
    const amount = data[field];
    const [min, max] = mutedTuningBounds[field];
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < min || amount > max)
      throw Error("Invalid muted tuning amount");
  }
  if (!mutedMotions.includes(data["motion"] as MutedMotion)) throw Error("Invalid muted motion");
  return { ...data } as MutedTuning;
}
export function resetMutedTuning(current: MutedTuning, field?: MutedTuningField): MutedTuning {
  const defaults = defaultMutedTuning();
  return field ? { ...current, [field]: defaults[field] } : defaults;
}
