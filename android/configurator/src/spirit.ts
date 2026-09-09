export type SpiritSelection = {
  surface: "still" | "soft";
  strengthPercent: number;
  persona: "fixed" | "follow";
};

export function defaultSpirit(): SpiritSelection {
  return { surface: "still", strengthPercent: 35, persona: "fixed" };
}

export function parseSpirit(value: unknown): SpiritSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid spirit");
  const data = value as Record<string, unknown>;
  const keys = ["surface", "strengthPercent", "persona"];
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !(key in data)) ||
    (data["surface"] !== "still" && data["surface"] !== "soft") ||
    (data["persona"] !== "fixed" && data["persona"] !== "follow") ||
    typeof data["strengthPercent"] !== "number" ||
    !Number.isInteger(data["strengthPercent"]) ||
    data["strengthPercent"] < 0 ||
    data["strengthPercent"] > 100
  )
    throw Error("Invalid spirit");
  return {
    surface: data["surface"],
    strengthPercent: data["strengthPercent"],
    persona: data["persona"],
  };
}

export function equalSpirit(a: SpiritSelection, b: SpiritSelection) {
  return (
    a.surface === b.surface && a.strengthPercent === b.strengthPercent && a.persona === b.persona
  );
}
