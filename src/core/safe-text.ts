/** Shared ASCII-control checks for persisted identities and network metadata. */
export function containsAsciiControl(value: string, allowJsonWhitespace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code > 0x1f) continue;
    if (allowJsonWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    return true;
  }
  return false;
}

export function containsAsciiControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}
