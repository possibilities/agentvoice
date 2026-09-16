import { useCallback, useEffect, useState } from "react";
import { mergeTranscript } from "./merge";
import type { TranscriptSnapshot, TranscriptSource } from "./types";

export interface UseTranscriptOptions {
  /** Poll committed history even when the agent is idle. Defaults to true. */
  watch?: boolean;
  pollIntervalMs?: number;
}

export interface TranscriptState {
  snapshot: TranscriptSnapshot | null;
  loading: boolean;
  error: Error | null;
  retry: () => void;
}

interface ReadState {
  source: TranscriptSource;
  id: string;
  revision: number;
  snapshot: TranscriptSnapshot | null;
  loading: boolean;
  error: Error | null;
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** Keep a source stable (module scope or useMemo). Sources must honor AbortSignal. */
export function useTranscript(
  source: TranscriptSource,
  id: string | null,
  { watch = true, pollIntervalMs = 1000 }: UseTranscriptOptions = {},
): TranscriptState {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadState | null>(null);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const matches = state?.source === source && state.id === id;
  const current = matches ? state : null;
  const ready = current?.revision === revision && !current.loading && Boolean(current.snapshot);
  const interval = Number.isFinite(pollIntervalMs) ? Math.max(100, pollIntervalMs) : 1000;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState((previous) => ({
      source,
      id,
      revision,
      loading: true,
      error: null,
      snapshot: previous?.source === source && previous.id === id ? previous.snapshot : null,
    }));
    void source.load({ id, signal: controller.signal }).then(
      (snapshot) => {
        if (!controller.signal.aborted)
          setState({
            source,
            id,
            revision,
            snapshot,
            loading: false,
            error: null,
          });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState(
            (previous) =>
              previous && {
                ...previous,
                loading: false,
                error: asError(error),
              },
          );
      },
    );
    return () => controller.abort();
  }, [source, id, revision]);

  useEffect(() => {
    if (!id || !watch || !ready) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // This effect starts only after load; its cursor advances independently of renders.
    let cursor = current!.snapshot!.cursor;
    const poll = async () => {
      try {
        const update = await source.poll({
          id,
          cursor,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        cursor = update.cursor;
        setState((previous) =>
          previous?.snapshot
            ? {
                ...previous,
                snapshot: mergeTranscript(previous.snapshot, update),
                error: null,
              }
            : previous,
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setState((previous) => previous && { ...previous, error: asError(error) });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, interval);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // Snapshot changes must not restart polling. Each run owns its cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, id, ready, watch, interval, revision]);

  return {
    snapshot: current?.snapshot ?? null,
    loading: Boolean(id) && (!current || current.revision !== revision || current.loading),
    error: current?.error ?? null,
    retry,
  };
}
