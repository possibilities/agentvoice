import { haloMotionFields } from "./halo.ts";
import { type PhoneState, type Preview, previewOf } from "./protocol.ts";
import { type SpacingField, spacingFields } from "./spacing.ts";

export type ResetTarget =
  | "spacing"
  | `spacing-${SpacingField}`
  | "controls"
  | "size"
  | "position"
  | "animation"
  | "colors"
  | "light"
  | "traces"
  | "glow"
  | "spirit-colors";

export function resetPreview(current: Preview, defaults: PhoneState, target: ResetTarget): Preview {
  const next = previewOf(current);
  if (target.startsWith("spacing-")) {
    const field = target.slice("spacing-".length) as SpacingField;
    if (spacingFields.includes(field))
      next.design.spacing[field] = defaults.defaultDesign.spacing[field];
    return next;
  }
  switch (target) {
    case "spacing":
      next.design.spacing = { ...defaults.defaultDesign.spacing };
      break;
    case "traces":
      next.design.traces = {
        ...defaults.defaultDesign.traces,
        glowPercent: next.design.traces.glowPercent,
      };
      break;
    case "glow":
      next.design.traces.glowPercent = defaults.defaultDesign.traces.glowPercent;
      break;
    case "controls":
      next.design.controlsHeightDp = defaults.defaultDesign.controlsHeightDp;
      next.design.holdSharePercent = defaults.defaultDesign.holdSharePercent;
      break;
    case "size":
      if (next.halo.variant === "contained")
        next.halo.containedSizePercent = defaults.defaultHalo.containedSizePercent;
      else next.scales[next.mode] = defaults.defaults[next.mode];
      break;
    case "position":
      next.verticalOffsetDp = defaults.defaultVerticalOffsetDp;
      break;
    case "animation":
      for (const key of haloMotionFields) next.halo[key] = defaults.defaultHalo[key];
      break;
    case "colors":
      next.halo.colors = { ...defaults.defaultHalo.colors };
      break;
    case "light":
      next.spirit.surface = defaults.defaultSpirit.surface;
      next.spirit.strengthPercent = defaults.defaultSpirit.strengthPercent;
      break;
    case "spirit-colors":
      next.spirit.persona = defaults.defaultSpirit.persona;
      break;
  }
  return next;
}
