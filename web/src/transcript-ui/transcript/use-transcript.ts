import { useCallback, useEffect, useState } from "react";
import { mergeTranscript } from "./merge";
import type { TranscriptDetail, TranscriptSnapshot, TranscriptSource } from "./types";

export interface UseTranscriptOptions {
  detail?: TranscriptDetail;
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
  detail: TranscriptDetail;
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
  { detail = "messages", watch = true, pollIntervalMs = 1000 }: UseTranscriptOptions = {},
): TranscriptState {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadState | null>(null);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const matches = state?.source === source && state.id === id && state.detail === detail;
  const current = matches ? state : null;
  const ready = current?.revision === revision && !current.loading && Boolean(current.snapshot);
  const interval = Number.isFinite(pollIntervalMs) ? Math.max(100, pollIntervalMs) : 1000;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState((previous) => ({
      source,
      id,
      detail,
      revision,
      loading: true,
      error: null,
      snapshot:
        previous?.source === source && previous.id === id && previous.detail === detail
          ? previous.snapshot
          : null,
    }));
    void source.load({ id, detail, signal: controller.signal }).then(
      (snapshot) => {
        if (!controller.signal.aborted)
          setState({
            source,
            id,
            detail,
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
  }, [source, id, detail, revision]);

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
          detail,
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
  }, [source, id, detail, ready, watch, interval, revision]);

  return {
    snapshot: current?.snapshot ?? null,
    loading: Boolean(id) && (!current || current.revision !== revision || current.loading),
    error: current?.error ?? null,
    retry,
  };
}
