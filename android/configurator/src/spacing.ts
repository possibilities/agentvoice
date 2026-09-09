export const spacingBounds = {
  sideMarginPercent: [0, 200],
  edgeClearancePercent: [0, 200],
  sectionGapDp: [0, 80],
  channelGapDp: [0, 40],
  pushGapDp: [0, 48],
} as const;
export type SpacingField = keyof typeof spacingBounds;
export const spacingFields = Object.keys(spacingBounds) as SpacingField[];
export type Spacing = Record<SpacingField, number>;
export function defaultSpacing(): Spacing {
  return {
    sideMarginPercent: 100,
    edgeClearancePercent: 100,
    sectionGapDp: 0,
    channelGapDp: 10,
    pushGapDp: 16,
  };
}
export function parseSpacing(value: unknown): Spacing {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid spacing");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== spacingFields.length) throw Error("Invalid spacing fields");
  for (const key of spacingFields) {
    const amount = data[key];
    const [min, max] = spacingBounds[key];
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < min || amount > max)
      throw Error("Invalid spacing amount");
  }
  return { ...data } as Spacing;
}
export function equalSpacing(a: Spacing, b: Spacing): boolean {
  return spacingFields.every((key) => a[key] === b[key]);
}
