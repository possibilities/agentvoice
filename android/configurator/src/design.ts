export const headerChoices = ["quiet", "drawer", "none"] as const;
export const muteChoices = ["glyphs", "rockers", "keycaps"] as const;
export const holdChoices = ["beam", "trigger", "keycap"] as const;
export type Design = {
  layout: "original" | "studio";
  header: (typeof headerChoices)[number];
  mute: (typeof muteChoices)[number];
  hold: (typeof holdChoices)[number];
};
export const originalDesign: Design = {
  layout: "original",
  header: "quiet",
  mute: "glyphs",
  hold: "beam",
};
export const directions: { id: string; name: string; description: string; design: Design }[] = [
  {
    id: "original",
    name: "Current",
    description: "The existing app, for comparison.",
    design: originalDesign,
  },
  {
    id: "signal",
    name: "Signal",
    description: "Quiet chrome. Bold symbols.",
    design: { layout: "studio", header: "quiet", mute: "glyphs", hold: "beam" },
  },
  {
    id: "radio",
    name: "Field radio",
    description: "A revealing header and physical controls.",
    design: { layout: "studio", header: "drawer", mute: "rockers", hold: "trigger" },
  },
  {
    id: "terminal",
    name: "Ghost terminal",
    description: "Hidden chrome. Oversized keycaps.",
    design: { layout: "studio", header: "none", mute: "keycaps", hold: "keycap" },
  },
];
export function equalDesign(a: Design, b: Design) {
  return a.layout === b.layout && a.header === b.header && a.mute === b.mute && a.hold === b.hold;
}
export function parseDesign(value: unknown): Design {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid design");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    !["original", "studio"].includes(data["layout"] as string) ||
    !headerChoices.includes(data["header"] as Design["header"]) ||
    !muteChoices.includes(data["mute"] as Design["mute"]) ||
    !holdChoices.includes(data["hold"] as Design["hold"])
  )
    throw Error("Invalid design");
  return {
    layout: data["layout"] as Design["layout"],
    header: data["header"] as Design["header"],
    mute: data["mute"] as Design["mute"],
    hold: data["hold"] as Design["hold"],
  };
}
