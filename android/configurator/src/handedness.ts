import type { PersonaSide, Preview } from "./protocol.ts";

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
