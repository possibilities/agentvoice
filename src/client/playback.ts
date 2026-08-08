export interface SinkResultHandlers {
  resolved(): void;
  rejected(error: unknown): void;
}

/** Observe Bun FileSink backpressure without leaving rejection unhandled. */
export function observeSinkResult(result: unknown, handlers: SinkResultHandlers): boolean {
  if (!isPromiseLike(result)) return false;
  void Promise.resolve(result).then(handlers.resolved, handlers.rejected);
  return true;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
}
