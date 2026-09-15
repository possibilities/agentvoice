import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

interface DisclosureStore {
  get(keys: readonly string[]): boolean | undefined;
  any(keys: readonly string[]): boolean;
  set(keys: readonly string[], open: boolean): void;
  subscribe(keys: readonly string[], listener: () => void): () => void;
}

const DisclosureStateContext = createContext<DisclosureStore | null>(null);

function createDisclosureStore(): DisclosureStore {
  const values = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(keys) {
      return keys.map((key) => values.get(key)).find((value) => value !== undefined);
    },
    any(keys) {
      return keys.some((key) => values.get(key) === true);
    },
    set(keys, open) {
      const notify = new Set<() => void>();
      for (const key of keys) {
        if (values.get(key) === open) continue;
        values.set(key, open);
        for (const listener of listeners.get(key) ?? []) notify.add(listener);
      }
      for (const listener of notify) listener();
    },
    subscribe(keys, listener) {
      for (const key of keys) {
        const subscribers = listeners.get(key) ?? new Set();
        subscribers.add(listener);
        listeners.set(key, subscribers);
      }
      return () => {
        for (const key of keys) {
          const subscribers = listeners.get(key);
          subscribers?.delete(listener);
          if (subscribers?.size === 0) listeners.delete(key);
        }
      };
    },
  };
}

/** Keeps disclosure choices above message grouping, where live updates cannot remount them. */
export function DisclosureStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createDisclosureStore);
  return (
    <DisclosureStateContext.Provider value={store}>{children}</DisclosureStateContext.Provider>
  );
}

function useStoredDisclosure(keys: string | readonly string[]) {
  const store = useContext(DisclosureStateContext);
  const stableKeys = useMemo(() => (typeof keys === "string" ? [keys] : keys), [keys]);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(stableKeys, listener) ?? (() => {}),
    [stableKeys, store],
  );
  const getSnapshot = useCallback(() => store?.get(stableKeys), [stableKeys, store]);
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

export function useAnyDisclosure(keys: string | readonly string[]) {
  const store = useContext(DisclosureStateContext);
  const stableKeys = useMemo(() => (typeof keys === "string" ? [keys] : keys), [keys]);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(stableKeys, listener) ?? (() => {}),
    [stableKeys, store],
  );
  const getSnapshot = useCallback(() => store?.any(stableKeys) ?? false, [stableKeys, store]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useDisclosureState(keys: string | readonly string[], defaultOpen = false) {
  const store = useContext(DisclosureStateContext);
  const stableKeys = useMemo(() => (typeof keys === "string" ? [keys] : keys), [keys]);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const stored = useStoredDisclosure(stableKeys);
  const open = store ? (stored ?? defaultOpen) : localOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (store) store.set(stableKeys, next);
      else setLocalOpen(next);
    },
    [stableKeys, store],
  );
  return [open, setOpen] as const;
}
