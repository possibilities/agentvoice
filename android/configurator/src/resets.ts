import { haloMotionFields } from "./halo.ts";
import { defaultIcons } from "./icons.ts";
import { type MutedTuningField, mutedTuningFields, resetMutedTuning } from "./muted-presence.ts";
import { type PhoneState, type Preview, previewOf } from "./protocol.ts";
import { type SpacingField, spacingFields } from "./spacing.ts";
import { traceTipFields } from "./traces.ts";

export type ResetTarget =
  | "channel-icons"
  | "push-icon"
  | "sounds"
  | "muted-appearance"
  | `muted-${MutedTuningField}`
  | "spacing"
  | `spacing-${SpacingField}`
  | "controls"
  | "size"
  | "position"
  | "animation"
  | "colors"
  | "light"
  | `trace-${(typeof traceTipFields)[number]}`
  | "traces"
  | "glow"
  | "spirit-colors";

export function resetPreview(current: Preview, defaults: PhoneState, target: ResetTarget): Preview {
  const next = previewOf(current);
  if (target === "muted-appearance") {
    next.mutedTuning = resetMutedTuning(next.mutedTuning);
    return next;
  }
  if (target.startsWith("muted-")) {
    const field = target.slice("muted-".length) as MutedTuningField;
    if (mutedTuningFields.includes(field))
      next.mutedTuning = resetMutedTuning(next.mutedTuning, field);
    return next;
  }
  if (target.startsWith("trace-")) {
    const field = target.slice("trace-".length) as (typeof traceTipFields)[number];
    if (traceTipFields.includes(field))
      next.design.traces[field] = defaults.defaultSharedAppearance.traces[field];
    return next;
  }
  if (target.startsWith("spacing-")) {
    const field = target.slice("spacing-".length) as SpacingField;
    if (spacingFields.includes(field))
      next.design.spacing[field] = defaults.defaultDesign.spacing[field];
    return next;
  }
  switch (target) {
    case "channel-icons":
      next.icons.channels = defaultIcons().channels;
      break;
    case "push-icon":
      next.icons.push = defaultIcons().push;
      break;
    case "sounds":
      next.sounds = { ...defaults.defaultSounds };
      break;
    case "spacing":
      next.design.spacing = { ...defaults.defaultDesign.spacing };
      break;
    case "traces":
      next.design.traces = {
        ...defaults.defaultSharedAppearance.traces,
        glowPercent: next.design.traces.glowPercent,
      };
      break;
    case "glow":
      next.design.traces.glowPercent = defaults.defaultSharedAppearance.glowPercent;
      break;
    case "controls":
      if (next.showPushToTalk) {
        next.design.controlsHeightDp = defaults.defaultDesign.controlsHeightDp;
        next.design.holdSharePercent = defaults.defaultDesign.holdSharePercent;
      } else next.design.controlsWithoutPttDp = defaults.defaultDesign.controlsWithoutPttDp;
      break;
    case "size":
      if (next.halo.variant === "contained")
        next.halo.containedSizePercent = defaults.defaultHalo.containedSizePercent;
      else next.scales[next.mode] = defaults.defaults[next.mode];
      break;
    case "position":
      if (next.orientation === "landscape")
        next.horizontalOffsetDp = defaults.defaultHorizontalOffsetDp;
      else next.verticalOffsetDp = defaults.defaultVerticalOffsetDp;
      break;
    case "animation":
      for (const key of haloMotionFields)
        next.halo[key] = defaults.defaultSharedAppearance.halo[key];
      break;
    case "colors":
      next.halo.colors = { ...defaults.defaultSharedAppearance.halo.colors };
      break;
    case "light":
      next.spirit.surface = defaults.defaultSharedAppearance.spirit.surface;
      next.spirit.strengthPercent = defaults.defaultSharedAppearance.spirit.strengthPercent;
      break;
    case "spirit-colors":
      next.spirit.persona = defaults.defaultSharedAppearance.spirit.persona;
      break;
  }
  return next;
}
