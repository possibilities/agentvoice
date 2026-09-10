import { type PersonaSide, type Preview, type Profile, profileLayout } from "./protocol.ts";

/** Mirror manual placement with the deck; a second switch restores the exact layout. */
export function withPersonaSide(current: Preview, personaSide: PersonaSide): Preview {
  if (
    current.orientation === "portrait" ||
    current.orientation === "portrait-reverse" ||
    current.personaSide === personaSide
  )
    return current;
  return { ...current, personaSide, horizontalOffsetDp: -current.horizontalOffsetDp || 0 };
}

/** Opposite rotation puts the cutout on the equivalent edge after changing hands. */
export function balancedHandedLayout(current: Preview, production: Profile): Preview {
  if (current.orientation !== "landscape" && current.orientation !== "landscape-reverse")
    return current;
  const adopted = profileLayout(production, current.orientation);
  const opposite = current.orientation === "landscape" ? "landscape-reverse" : "landscape";
  const source =
    current.personaSide === adopted.personaSide ? adopted : profileLayout(production, opposite);
  const direction = current.personaSide === source.personaSide ? 1 : -1;
  return {
    ...current,
    scales: { ...source.scales },
    horizontalOffsetDp: source.horizontalOffsetDp * direction || 0,
    halo: { ...current.halo, containedSizePercent: source.halo.containedSizePercent },
    design: {
      ...current.design,
      controlsHeightDp: source.design.controlsHeightDp,
      controlsWithoutPttDp: source.design.controlsWithoutPttDp,
      holdSharePercent: source.design.holdSharePercent,
    },
  };
}
