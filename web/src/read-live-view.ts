import type { LiveView } from "./types.ts";

export type LiveReadResult =
  | { unchanged: true; etag?: string }
  | { unchanged: false; etag?: string; view: LiveView };

type LiveReadOptions = {
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  headerTimeoutMs?: number;
  bodyTimeoutMs?: number;
};

/**
 * Bound an unavailable reader before it responds, but let an accepted local
 * response finish. Large bounded histories can take longer to transfer and
 * decode under load than the connection-health timeout.
 */
export async function readLiveView(
  signal: AbortSignal,
  etag?: string,
  { fetcher = fetch, headerTimeoutMs = 10_000, bodyTimeoutMs = 60_000 }: LiveReadOptions = {},
): Promise<LiveReadResult> {
  const headerTimeout = new AbortController();
  const request = new AbortController();
  const timer = setTimeout(() => headerTimeout.abort(), headerTimeoutMs);
  let response: Response;
  try {
    response = await fetcher("/api/live", {
      signal: AbortSignal.any([signal, request.signal, headerTimeout.signal]),
      cache: "no-store",
      ...(etag ? { headers: { "If-None-Match": etag } } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
  const nextEtag = response.headers.get("ETag") ?? undefined;
  if (response.status === 304) return { unchanged: true, etag: nextEtag ?? etag };
  if (!response.ok) throw new Error("Unavailable");
  const bodyTimer = setTimeout(() => request.abort(), bodyTimeoutMs);
  try {
    return {
      unchanged: false,
      etag: nextEtag,
      view: (await response.json()) as LiveView,
    };
  } finally {
    clearTimeout(bodyTimer);
  }
}
