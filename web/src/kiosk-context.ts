/** This identifies a native browser window for entry recovery, never native action authority. */
export function kioskPersistenceInstanceId(): string | undefined {
  const bridge = (globalThis as { funkKiosk?: unknown }).funkKiosk;
  if (!bridge || typeof bridge !== "object") return undefined;
  const value = (bridge as { persistenceInstanceId?: unknown }).persistenceInstanceId;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}
