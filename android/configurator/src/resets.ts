import { haloMotionFields } from "./halo.ts";
import { type PhoneState, type Preview, previewOf } from "./protocol.ts";

export type ResetTarget = "controls" | "size" | "position" | "animation" | "colors";

export function resetPreview(current: Preview, defaults: PhoneState, target: ResetTarget): Preview {
  const next = previewOf(current);
  switch (target) {
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
  }
  return next;
}
