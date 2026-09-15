export type PersistedFollowUpMode = "steer" | "queue";

export interface PersistedComposerRecovery {
  clientId: string;
  text: string;
  error: string;
}

export interface PersistedComposerPending {
  clientId: string;
  text: string;
  mode: "send" | PersistedFollowUpMode;
  pageId: string;
}

export interface PersistedComposerEditing {
  id: string;
  text: string;
  savedDraft: string;
  pageId: string;
}

export interface PersistedComposerState {
  draft: string;
  followUpMode: PersistedFollowUpMode;
  recoveries: PersistedComposerRecovery[];
  pending: PersistedComposerPending[];
  editing: PersistedComposerEditing | null;
}

interface PersistedComposerEntryJournal {
  version: 1;
  tabId: string;
  updatedAt: number;
  draft: string;
  editing: PersistedComposerEditing | null;
}

interface PersistedComposerSlot {
  tabId: string;
  updatedAt: number;
  state: PersistedComposerState;
}

interface PersistedComposerRecord {
  version: 2;
  tabId: string;
  updatedAt: number;
  state: PersistedComposerState;
}

export interface LoadedComposerState {
  state: PersistedComposerState;
  changed: boolean;
  storageAvailable: boolean;
}

// These historical keys preserve already recovered AgentVoice drafts across the
// source transfer. They are compatibility identifiers, not an AgentChats dependency.
const STORAGE_PREFIX = "@agentchats/transcript:composer:v2:";
const TAB_ID_KEY = "@agentchats/transcript:composer-tab:v1";
const UNKNOWN_DELIVERY = "Delivery status is unknown after reload. This text was not resent.";
const RECOVERED_DRAFT = "Draft recovered from another browser session. It was not sent.";
const RECOVERED_EDIT =
  "Queued edit recovered from another browser session. Review it before sending.";
const PAGE_ID_SYMBOL = Symbol.for("@agentchats/transcript/composer-page-id");
const TAB_ID_SYMBOL = Symbol.for("@agentchats/transcript/composer-tab-id");
const MEMORY_SYMBOL = Symbol.for("@agentchats/transcript/composer-memory-v2");

let fallbackSequence = 0;

function createId(kind: string) {
  return (
    globalThis.crypto?.randomUUID?.() ?? `agentchats-${kind}-${Date.now()}-${++fallbackSequence}`
  );
}

const pageGlobal = globalThis as unknown as Record<PropertyKey, unknown>;
const existingPageId = pageGlobal[PAGE_ID_SYMBOL];
export const composerPageId =
  typeof existingPageId === "string" ? existingPageId : createId("page");
pageGlobal[PAGE_ID_SYMBOL] = composerPageId;
const existingMemory = pageGlobal[MEMORY_SYMBOL];
const memory =
  existingMemory instanceof Map
    ? (existingMemory as Map<
        string,
        {
          state: PersistedComposerState;
          dirty: boolean;
          storageAvailable: boolean;
          blocked: boolean;
        }
      >)
    : new Map<
        string,
        {
          state: PersistedComposerState;
          dirty: boolean;
          storageAvailable: boolean;
          blocked: boolean;
        }
      >();
pageGlobal[MEMORY_SYMBOL] = memory;

function readTabId() {
  const cached = pageGlobal[TAB_ID_SYMBOL];
  if (typeof cached === "string") return cached;
  if (typeof window === "undefined") return "server";
  try {
    const stored = window.sessionStorage.getItem(TAB_ID_KEY);
    if (stored) {
      pageGlobal[TAB_ID_SYMBOL] = stored;
      return stored;
    }
    const created = createId("tab");
    window.sessionStorage.setItem(TAB_ID_KEY, created);
    pageGlobal[TAB_ID_SYMBOL] = created;
    return created;
  } catch {
    const fallback = createId("tab");
    pageGlobal[TAB_ID_SYMBOL] = fallback;
    return fallback;
  }
}

function readSlotId(instanceId?: string) {
  return instanceId ? `instance:${instanceId}` : readTabId();
}

export function composerStorageKey(scope: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}`;
}

function composerMemoryKey(scope: string, instanceId?: string) {
  return composerSlotKey(scope, readSlotId(instanceId));
}

function composerSlotKey(scope: string, tabId: string) {
  return `${composerStorageKey(scope)}:${encodeURIComponent(tabId)}`;
}

function composerJournalKey(scope: string, tabId: string) {
  return `${composerSlotKey(scope, tabId)}:entry`;
}

export function cacheComposerState(
  scope: string | undefined,
  state: PersistedComposerState,
  instanceId?: string,
) {
  if (scope) {
    const key = composerMemoryKey(scope, instanceId);
    const previous = memory.get(key);
    memory.set(key, {
      state,
      dirty: true,
      storageAvailable: previous?.storageAvailable ?? true,
      blocked: previous?.blocked ?? false,
    });
  }
}

export function emptyComposerState(defaultValue = ""): PersistedComposerState {
  return {
    draft: defaultValue,
    followUpMode: "steer",
    recoveries: [],
    pending: [],
    editing: null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseRecovery(value: unknown): PersistedComposerRecovery | null {
  if (!isObject(value)) return null;
  const clientId = stringValue(value.clientId);
  const text = stringValue(value.text);
  const error = stringValue(value.error);
  return clientId && text !== null && error ? { clientId, text, error } : null;
}

function parsePending(value: unknown): PersistedComposerPending | null {
  if (!isObject(value)) return null;
  const clientId = stringValue(value.clientId);
  const text = stringValue(value.text);
  const pageId = stringValue(value.pageId);
  const mode = value.mode;
  return clientId &&
    text !== null &&
    pageId &&
    (mode === "send" || mode === "steer" || mode === "queue")
    ? { clientId, text, pageId, mode }
    : null;
}

function parseEditing(value: unknown): PersistedComposerEditing | null {
  if (!isObject(value)) return null;
  const id = stringValue(value.id);
  const text = stringValue(value.text);
  const savedDraft = stringValue(value.savedDraft);
  const pageId = stringValue(value.pageId);
  return id && text !== null && savedDraft !== null && pageId
    ? { id, text, savedDraft, pageId }
    : null;
}

function parseState(value: unknown): PersistedComposerState | null {
  if (!isObject(value)) return null;
  const draft = stringValue(value.draft);
  if (draft === null) return null;
  return {
    draft,
    followUpMode: value.followUpMode === "queue" ? "queue" : "steer",
    recoveries: Array.isArray(value.recoveries)
      ? value.recoveries.flatMap((entry) => {
          const recovery = parseRecovery(entry);
          return recovery ? [recovery] : [];
        })
      : [],
    pending: Array.isArray(value.pending)
      ? value.pending.flatMap((entry) => {
          const pending = parsePending(entry);
          return pending ? [pending] : [];
        })
      : [],
    editing: parseEditing(value.editing),
  };
}

function parseRecord(value: unknown): PersistedComposerRecord | null {
  if (
    !isObject(value) ||
    value.version !== 2 ||
    typeof value.tabId !== "string" ||
    typeof value.updatedAt !== "number"
  )
    return null;
  const state = parseState(value.state);
  return state ? { version: 2, tabId: value.tabId, updatedAt: value.updatedAt, state } : null;
}

function parseJournal(value: unknown): PersistedComposerEntryJournal | null {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.tabId !== "string" ||
    typeof value.updatedAt !== "number" ||
    typeof value.draft !== "string"
  )
    return null;
  const editing = parseEditing(value.editing);
  if (value.editing !== null && !editing) return null;
  return {
    version: 1,
    tabId: value.tabId,
    updatedAt: value.updatedAt,
    draft: value.draft,
    editing,
  };
}

function applyJournal(
  state: PersistedComposerState,
  journal: PersistedComposerEntryJournal | null,
) {
  return journal ? { ...state, draft: journal.draft, editing: journal.editing } : state;
}

function uniqueByClientId<T extends { clientId: string }>(values: T[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.clientId)) return false;
    seen.add(value.clientId);
    return true;
  });
}

function recoverPending(state: PersistedComposerState, observed: ReadonlySet<string>) {
  const pending: PersistedComposerPending[] = [];
  const recoveries = state.recoveries.filter((entry) => !observed.has(entry.clientId));
  for (const entry of state.pending) {
    if (observed.has(entry.clientId)) continue;
    if (entry.pageId === composerPageId) pending.push(entry);
    else
      recoveries.push({
        clientId: entry.clientId,
        text: entry.text,
        error: UNKNOWN_DELIVERY,
      });
  }
  return {
    ...state,
    recoveries: uniqueByClientId(recoveries),
    pending: uniqueByClientId(pending),
  };
}

function recoverOtherSlots(
  slots: readonly PersistedComposerSlot[],
  observed: ReadonlySet<string>,
  defaultValue: string,
) {
  const ordered = slots.toSorted((left, right) => right.updatedAt - left.updatedAt);
  const newest = ordered[0]?.state;
  const recoveries: PersistedComposerRecovery[] = [];
  for (const slot of ordered) {
    const slotId = slot.tabId;
    const state = slot.state;
    recoveries.push(...state.recoveries.filter((entry) => !observed.has(entry.clientId)));
    for (const pending of state.pending)
      if (!observed.has(pending.clientId))
        recoveries.push({
          clientId: pending.clientId,
          text: pending.text,
          error: UNKNOWN_DELIVERY,
        });
    if (state.draft)
      recoveries.push({
        clientId: `recovered-draft:${slotId}`,
        text: state.draft,
        error: RECOVERED_DRAFT,
      });
    if (state.editing?.text)
      recoveries.push({
        clientId: `recovered-edit:${slotId}:${state.editing.id}`,
        text: state.editing.text,
        error: RECOVERED_EDIT,
      });
  }
  return {
    ...emptyComposerState(defaultValue),
    followUpMode: newest?.followUpMode ?? "steer",
    recoveries: uniqueByClientId(recoveries),
  };
}

export function loadComposerState(
  scope: string | undefined,
  defaultValue: string,
  observedSubmissionIds: readonly string[],
  instanceId?: string,
): LoadedComposerState {
  const fallback = emptyComposerState(defaultValue);
  if (!scope || typeof window === "undefined")
    return { state: fallback, changed: false, storageAvailable: true };

  const observed = new Set(observedSubmissionIds);
  const memoryKey = composerMemoryKey(scope, instanceId);
  const cached = memory.get(memoryKey);
  if (cached) {
    const state = recoverPending(cached.state, observed);
    return {
      state,
      changed:
        cached.dirty ||
        state.pending.length !== cached.state.pending.length ||
        state.recoveries.length !== cached.state.recoveries.length,
      storageAvailable: cached.storageAvailable,
    };
  }

  const tabId = readSlotId(instanceId);
  const slotKey = composerSlotKey(scope, tabId);
  const journalKey = composerJournalKey(scope, tabId);
  let serialized: string | null;
  let serializedJournal: string | null;
  try {
    serialized = window.localStorage.getItem(slotKey);
    serializedJournal = window.localStorage.getItem(journalKey);
  } catch {
    memory.set(memoryKey, {
      state: fallback,
      dirty: false,
      storageAvailable: false,
      blocked: true,
    });
    return { state: fallback, changed: false, storageAvailable: false };
  }
  if (!serialized && !serializedJournal) {
    const otherSlots: PersistedComposerSlot[] = [];
    const records = new Map<string, PersistedComposerRecord>();
    const journals = new Map<string, PersistedComposerEntryJournal>();
    try {
      const prefix = `${composerStorageKey(scope)}:`;
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key?.startsWith(prefix) || key === slotKey) continue;
        const candidate = window.localStorage.getItem(key);
        if (!candidate) continue;
        const parsed = JSON.parse(candidate);
        if (key.endsWith(":entry")) {
          const journal = parseJournal(parsed);
          if (journal && journal.tabId !== tabId) journals.set(journal.tabId, journal);
        } else {
          const record = parseRecord(parsed);
          if (record && record.tabId !== tabId) records.set(record.tabId, record);
        }
      }
      for (const otherTabId of new Set([...records.keys(), ...journals.keys()])) {
        const record = records.get(otherTabId);
        const journal = journals.get(otherTabId);
        otherSlots.push({
          tabId: otherTabId,
          updatedAt: Math.max(record?.updatedAt ?? 0, journal?.updatedAt ?? 0),
          state: applyJournal(record?.state ?? emptyComposerState(), journal ?? null),
        });
      }
    } catch {
      return { state: fallback, changed: false, storageAvailable: false };
    }
    const state = recoverOtherSlots(otherSlots, observed, defaultValue);
    return {
      state,
      changed: state.recoveries.length > 0 || state.followUpMode !== "steer",
      storageAvailable: true,
    };
  }

  let record: PersistedComposerRecord | null;
  let journal: PersistedComposerEntryJournal | null;
  try {
    record = serialized ? parseRecord(JSON.parse(serialized)) : null;
    journal = serializedJournal ? parseJournal(JSON.parse(serializedJournal)) : null;
  } catch {
    record = null;
    journal = null;
  }
  const unreadable = Boolean((serialized && !record) || (serializedJournal && !journal));
  const journalIsNewer = Boolean(journal && (!record || journal.updatedAt >= record.updatedAt));
  const durableState = applyJournal(record?.state ?? fallback, journalIsNewer ? journal : null);
  if (unreadable)
    memory.set(memoryKey, {
      state: durableState,
      dirty: false,
      storageAvailable: false,
      blocked: true,
    });
  if (unreadable) return { state: durableState, changed: false, storageAvailable: false };

  const state = recoverPending(durableState, observed);
  return {
    state,
    changed:
      journalIsNewer ||
      state.pending.length !== durableState.pending.length ||
      state.recoveries.length !== durableState.recoveries.length,
    storageAvailable: true,
  };
}

export function writeComposerState(
  scope: string | undefined,
  state: PersistedComposerState,
  instanceId?: string,
  mergeEntryJournal = false,
) {
  if (!scope || typeof window === "undefined") return state;
  const memoryKey = composerMemoryKey(scope, instanceId);
  cacheComposerState(scope, state, instanceId);
  if (memory.get(memoryKey)?.blocked) return null;
  let nextState = state;
  try {
    const tabId = readSlotId(instanceId);
    if (mergeEntryJournal) {
      const serializedJournal = window.localStorage.getItem(composerJournalKey(scope, tabId));
      if (serializedJournal) {
        const journal = parseJournal(JSON.parse(serializedJournal));
        if (!journal) throw new Error("Unreadable composer entry journal");
        nextState = applyJournal(state, journal);
      }
    }
    window.localStorage.setItem(
      composerSlotKey(scope, tabId),
      JSON.stringify({
        version: 2,
        tabId,
        updatedAt: Date.now(),
        state: nextState,
      }),
    );
    window.localStorage.removeItem(composerJournalKey(scope, tabId));
    memory.set(memoryKey, {
      state: nextState,
      dirty: false,
      storageAvailable: true,
      blocked: false,
    });
    return nextState;
  } catch {
    memory.set(memoryKey, {
      state: nextState,
      dirty: true,
      storageAvailable: false,
      blocked: false,
    });
    return null;
  }
}

export function writeComposerEntryJournal(
  scope: string | undefined,
  state: PersistedComposerState,
  instanceId?: string,
) {
  if (!scope || typeof window === "undefined") return true;
  const memoryKey = composerMemoryKey(scope, instanceId);
  cacheComposerState(scope, state, instanceId);
  const blocked = memory.get(memoryKey)?.blocked ?? false;
  try {
    const tabId = readSlotId(instanceId);
    window.localStorage.setItem(
      composerJournalKey(scope, tabId),
      JSON.stringify({
        version: 1,
        tabId,
        updatedAt: Date.now(),
        draft: state.draft,
        editing: state.editing,
      } satisfies PersistedComposerEntryJournal),
    );
    const cached = memory.get(memoryKey);
    if (cached)
      memory.set(memoryKey, {
        ...cached,
        storageAvailable: blocked ? false : true,
      });
    return !blocked;
  } catch {
    memory.set(memoryKey, {
      state,
      dirty: true,
      storageAvailable: false,
      blocked,
    });
    return false;
  }
}
