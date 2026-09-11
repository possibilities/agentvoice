import { haloMotionFields } from "./halo.ts";
import { type MutedTuningField, mutedTuningFields } from "./muted-presence.ts";
import {
  type PhoneState,
  type Preview,
  previewOf,
  scaleMode,
  visualSettingsOf,
} from "./protocol.ts";
import { type SpacingField, spacingFields } from "./spacing.ts";
import { traceTipFields } from "./traces.ts";

export type ResetTarget =
  | "visual-settings"
  | "launcher"
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
    next.mutedTuning = { ...defaults.defaultAppearance.mutedTuning };
    return next;
  }
  if (target.startsWith("muted-")) {
    const field = target.slice("muted-".length) as MutedTuningField;
    if (mutedTuningFields.includes(field))
      next.mutedTuning = {
        ...next.mutedTuning,
        [field]: defaults.defaultAppearance.mutedTuning[field],
      };
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
    case "visual-settings":
      return { ...next, ...visualSettingsOf(defaults.defaultAppearance) };
    case "launcher":
      next.launcher = defaults.defaultAppearance.launcher;
      break;
    case "channel-icons":
      next.icons.channels = defaults.defaultAppearance.icons.channels;
      break;
    case "push-icon":
      next.icons.push = defaults.defaultAppearance.icons.push;
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
      else next.scales[scaleMode(next.mode)] = defaults.defaults[scaleMode(next.mode)];
      break;
    case "position":
      if (next.orientation === "landscape" || next.orientation === "landscape-reverse")
        next.horizontalOffsetDp =
          defaults.defaultHorizontalOffsetDp *
            (next.personaSide === defaults.defaultPersonaSide ? 1 : -1) || 0;
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
