import { cn } from "cn";
import { ArrowUpIcon, ChevronDownIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  CLIPBOARD_IMAGE_MIME_TYPES,
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_LOCAL_IMAGES,
} from "../../../../src/attachment/image-contract";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "../components/ui/input-group";
import type { ComposerImage, SaveClipboardImage } from "./composer-images";
import {
  cacheComposerState,
  composerPageId,
  loadComposerState,
  type PersistedComposerEditing,
  type PersistedComposerRecovery,
  type PersistedComposerState,
  writeComposerEntryJournal,
  writeComposerState,
} from "./composer-persistence";
import { FileReferencePicker } from "./file-reference-picker";
import {
  insertFileReferences,
  type ListReferenceFiles,
  transferredReferencePaths,
} from "./file-references";

export type TranscriptFollowUpMode = "steer" | "queue";
type ActionResult = void | Promise<void>;

export interface TranscriptSubmission {
  /** Host-visible identity for optimistic rendering and exact transport reconciliation. */
  clientId: string;
  mode: "send" | TranscriptFollowUpMode;
  images?: ComposerImage[];
}

let submissionSequence = 0;
const persistenceOwners = new Map<string, string>();
const STORAGE_ERROR =
  "Browser storage is unavailable. Your draft remains here but may not survive a reload.";
const STORAGE_SUBMIT_ERROR =
  "Browser storage is unavailable. This message may not be recoverable after a reload.";
const EMPTY_SUBMISSION_IDS: readonly string[] = [];

function createSubmissionClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `agentchats-${Date.now()}-${++submissionSequence}`;
}

export interface TranscriptQueuedMessage {
  id: string;
  text: string;
  images?: ComposerImage[];
  pausedReason?: string;
  disabled?: boolean;
  canSteer?: boolean;
  canResume?: boolean;
}

export interface TranscriptComposerProps {
  /** Change with the host's view incarnation; resets local state when persistence is off. */
  transcriptId: string;
  /** An agent turn is running. This does not disable entering follow-ups. */
  active?: boolean;
  /** Verified host runtime reachability, independent of voice attachment. Omit for legacy idle styling. */
  reachable?: boolean;
  /** A host request is awaiting acknowledgment, independently of agent activity. */
  pending?: boolean;
  /** Keep true after interrupt acknowledgment until the terminal turn event. */
  stopping?: boolean;
  /** Disable actions while retaining a writable draft, for example during reconnect. */
  actionsDisabled?: boolean;
  disabled?: boolean;
  /** Keep one Send action visible through active and pending host states. */
  alwaysShowSend?: boolean;
  /** Clear accepted input before awaiting the callback and retain explicit failure recovery. */
  optimisticSubmit?: boolean;
  /** Stable opaque workspace + thread + lane identity for browser draft recovery. */
  persistenceScope?: string;
  /** Stable single-window host identity. Omit in ordinary multi-tab browsers. */
  persistenceInstanceId?: string;
  /** Exact client IDs already present in the authoritative transcript. */
  observedSubmissionIds?: readonly string[];
  /** Defaults to the Codex desktop setting, steer. */
  followUpMode?: TranscriptFollowUpMode;
  onFollowUpModeChange?: (mode: TranscriptFollowUpMode) => void;
  onSend?: (text: string, submission: TranscriptSubmission) => ActionResult;
  onSteer?: (text: string, submission: TranscriptSubmission) => ActionResult;
  onQueue?: (text: string, submission: TranscriptSubmission) => ActionResult;
  /** Omit to show noninteractive working status instead of Stop. */
  onInterrupt?: () => ActionResult;
  /** Host-owned FIFO. This component never drains or retries it automatically. */
  queue?: readonly TranscriptQueuedMessage[];
  onSteerQueued?: (id: string) => ActionResult;
  onResumeQueued?: (id: string) => ActionResult;
  /** Save edited text in the existing queue position; never submit a new turn. */
  onEditQueued?: (id: string, text: string, images?: ComposerImage[]) => ActionResult;
  onRemoveQueued?: (id: string) => ActionResult;
  /** Pause/exclude this row from host dispatch while its text is in the composer. */
  onEditingQueuedChange?: (id: string | null) => ActionResult;
  /** Read-only host file picker; selected paths remain ordinary message text. */
  listReferenceFiles?: ListReferenceFiles;
  /** Materialize raw clipboard images locally before submitting native localImage paths. */
  saveClipboardImage?: SaveClipboardImage;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}

/** Desktop-style Agent input. Hosts own queue state, transport and turn identity. */
export function TranscriptComposer(props: TranscriptComposerProps) {
  const key = props.persistenceScope
    ? `persistent:${props.persistenceScope}:${props.persistenceInstanceId ?? "tab"}`
    : props.transcriptId;
  return <Composer key={key} {...props} />;
}

function Composer({
  active = false,
  reachable,
  pending = false,
  stopping = false,
  actionsDisabled = false,
  disabled = false,
  alwaysShowSend = false,
  optimisticSubmit = false,
  persistenceScope,
  persistenceInstanceId,
  observedSubmissionIds = EMPTY_SUBMISSION_IDS,
  followUpMode,
  onFollowUpModeChange,
  onSend,
  onSteer,
  onQueue,
  onInterrupt,
  queue = [],
  onSteerQueued,
  onResumeQueued,
  onEditQueued,
  onRemoveQueued,
  onEditingQueuedChange,
  listReferenceFiles,
  saveClipboardImage,
  defaultValue = "",
  placeholder = "Message Agent…",
  className,
  "aria-label": label = "Message Agent",
}: TranscriptComposerProps) {
  const ownerId = useState(() => createSubmissionClientId())[0];
  const loaded = useState(() =>
    loadComposerState(persistenceScope, defaultValue, observedSubmissionIds, persistenceInstanceId),
  )[0];
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const imageSave = useRef<AbortController | null>(null);
  const [savingImages, setSavingImages] = useState(false);
  const referenceSelection = useRef({ start: 0, end: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const locked = useRef(false);
  const persisted = useRef<PersistedComposerState>(loaded.state);
  const persistenceTimer = useRef<number | null>(null);
  const persistenceDirty = useRef(loaded.changed);
  const initialEditing = loaded.state.editing;
  const draftRef = useRef(initialEditing?.text ?? loaded.state.draft);
  const imagesRef = useRef<ComposerImage[]>(initialEditing?.images ?? loaded.state.images ?? []);
  const [images, setImages] = useState(imagesRef.current);
  const [draft, setDraft] = useState(initialEditing?.text ?? loaded.state.draft);
  const [localMode, setLocalMode] = useState<TranscriptFollowUpMode>(loaded.state.followUpMode);
  const [operation, setOperation] = useState<string | null>(null);
  const [submissionPending, setSubmissionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(
    loaded.storageAvailable ? null : STORAGE_ERROR,
  );
  const recoveriesRef = useRef(loaded.state.recoveries);
  const [recoveries, setRecoveries] = useState(loaded.state.recoveries);
  const editingRef = useRef<PersistedComposerEditing | null>(initialEditing);
  const [editing, setEditing] = useState<PersistedComposerEditing | null>(initialEditing);
  const observedIdsRef = useRef(new Set(observedSubmissionIds));
  const mode = followUpMode ?? localMode;
  const unavailable =
    disabled || actionsDisabled || pending || operation !== null || stopping || savingImages;
  const editedRow = editing ? queue.find((row) => row.id === editing.id) : null;
  const action = !active ? onSend : mode === "steer" ? onSteer : onQueue;
  const actionLabel = editing
    ? "Save queued message"
    : !active
      ? "Send"
      : mode === "steer"
        ? "Steer"
        : "Queue";
  const canSubmit =
    (draft.trim().length > 0 || images.length > 0) &&
    !unavailable &&
    (editing ? Boolean(editedRow && !editedRow.disabled && onEditQueued) : Boolean(action));
  const showStop =
    !alwaysShowSend && !editing && active && draft.trim().length === 0 && images.length === 0;

  useEffect(() => () => imageSave.current?.abort(), []);

  function updateImages(next: ComposerImage[], immediate = true) {
    imagesRef.current = next;
    setImages(next);
    if (editingRef.current) {
      editingRef.current = { ...editingRef.current, text: draftRef.current, images: next };
      setEditing(editingRef.current);
    }
    updatePersistence(
      (current) =>
        editingRef.current
          ? { ...current, editing: { ...editingRef.current, text: draftRef.current, images: next } }
          : { ...current, images: next },
      immediate,
    );
  }

  async function pasteImages(files: readonly File[]) {
    if (
      !saveClipboardImage ||
      imageSave.current ||
      disabled ||
      (operation !== null && !submissionPending)
    )
      return;
    if (actionsDisabled) {
      setError("Reconnect to Agent before pasting an image. Your draft has been kept.");
      return;
    }
    if (imagesRef.current.length + files.length > MAX_LOCAL_IMAGES) {
      setError("Attach up to 4 clipboard images per message.");
      return;
    }
    for (const file of files) {
      if (!(CLIPBOARD_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
        setError("Paste a PNG, JPEG, WebP or GIF image. Use Reference a file for other files.");
        return;
      }
      if (file.size === 0 || file.size > MAX_CLIPBOARD_IMAGE_BYTES) {
        setError("Clipboard images must be nonempty and at most 10 MiB each.");
        return;
      }
    }
    const controller = new AbortController();
    imageSave.current = controller;
    setSavingImages(true);
    setError(null);
    try {
      // Keep paste order, bound memory, and retain already completed files if a later save fails.
      for (const file of files) {
        const image = await saveClipboardImage(file, createSubmissionClientId(), controller.signal);
        if (controller.signal.aborted || !ownsPersistence()) return;
        updateImages([...imagesRef.current, image]);
      }
      input.current?.focus();
    } catch (cause) {
      if (!controller.signal.aborted && ownsPersistence()) setError(failureMessage(cause));
    } finally {
      if (imageSave.current === controller) {
        imageSave.current = null;
        setSavingImages(false);
      }
    }
  }

  function imageAttachments(items: readonly ComposerImage[], removable = false) {
    return items.length ? (
      <ul
        className="transcript-composer__images"
        aria-label={removable ? "Attached images" : "Message images"}
      >
        {items.map((image, index) => (
          <li key={`${index}:${image.path}`} title={image.path}>
            <span>[Image #{index + 1}]</span>
            {removable ? (
              <button
                type="button"
                aria-label={`Remove Image #${index + 1}`}
                disabled={disabled || (operation !== null && !submissionPending)}
                onClick={() => {
                  updateImages(imagesRef.current.filter((_, position) => position !== index));
                  input.current?.focus();
                }}
              >
                <XIcon aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    ) : null;
  }

  function insertReferences(paths: readonly string[]) {
    const selection = referenceSelection.current;
    const next = insertFileReferences(draftRef.current, paths, selection.start, selection.end);
    updateDraft(next.text, true);
    setError(null);
    setPickerOpen(false);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  function captureSelection() {
    referenceSelection.current = {
      start: input.current?.selectionStart ?? draftRef.current.length,
      end: input.current?.selectionEnd ?? draftRef.current.length,
    };
  }

  function acceptTransfer(transfer: DataTransfer) {
    captureSelection();
    const paths = transferredReferencePaths(transfer);
    if (paths.length) insertReferences(paths);
    else
      setError(
        "This browser did not provide a full local file path. Use Reference a file or paste an absolute path. Paste a clipboard image to attach it instead.",
      );
  }

  function ownsPersistence() {
    if (!persistenceScope) return true;
    const owner = persistenceOwners.get(`${persistenceScope}:${persistenceInstanceId ?? "tab"}`);
    return owner === undefined || owner === ownerId;
  }

  function flushPersistence(mergeEntryJournal = true) {
    if (persistenceTimer.current !== null && typeof window !== "undefined") {
      window.clearTimeout(persistenceTimer.current);
      persistenceTimer.current = null;
    }
    if (!persistenceDirty.current || !ownsPersistence()) return true;
    const writtenState = writeComposerState(
      persistenceScope,
      persisted.current,
      persistenceInstanceId,
      mergeEntryJournal,
    );
    if (writtenState) {
      persisted.current = writtenState;
      draftRef.current = writtenState.editing?.text ?? writtenState.draft;
      persistenceDirty.current = false;
      setStorageWarning(null);
    }
    return Boolean(writtenState);
  }

  function updatePersistence(
    update: (current: PersistedComposerState) => PersistedComposerState,
    immediate = false,
  ) {
    persisted.current = update(persisted.current);
    persistenceDirty.current = true;
    if (!persistenceScope || !ownsPersistence()) return true;
    cacheComposerState(persistenceScope, persisted.current, persistenceInstanceId);
    if (immediate) {
      const written = flushPersistence(false);
      if (!written) setStorageWarning(STORAGE_ERROR);
      return written;
    }
    if (persistenceTimer.current === null && typeof window !== "undefined")
      persistenceTimer.current = window.setTimeout(() => {
        if (!flushPersistence()) setStorageWarning(STORAGE_ERROR);
      }, 120);
    return true;
  }

  useEffect(() => {
    if (!persistenceScope) return;
    const persistenceOwnerKey = `${persistenceScope}:${persistenceInstanceId ?? "tab"}`;
    persistenceOwners.set(persistenceOwnerKey, ownerId);
    if (!flushPersistence()) setStorageWarning(STORAGE_ERROR);
    const flushOnPageHide = () => {
      if (!flushPersistence()) setStorageWarning(STORAGE_ERROR);
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushOnPageHide();
    };
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      flushPersistence();
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      if (persistenceOwners.get(persistenceOwnerKey) === ownerId)
        persistenceOwners.set(persistenceOwnerKey, `unmounted:${ownerId}`);
    };
  }, [ownerId, persistenceInstanceId, persistenceScope]);

  useEffect(() => {
    observedIdsRef.current = new Set(observedSubmissionIds);
    if (observedSubmissionIds.length === 0) return;
    const observed = observedIdsRef.current;
    const nextRecoveries = recoveriesRef.current.filter((entry) => !observed.has(entry.clientId));
    const nextPending = persisted.current.pending.filter((entry) => !observed.has(entry.clientId));
    if (
      nextRecoveries.length === recoveriesRef.current.length &&
      nextPending.length === persisted.current.pending.length
    )
      return;
    recoveriesRef.current = nextRecoveries;
    setRecoveries(nextRecoveries);
    updatePersistence(
      (current) => ({
        ...current,
        recoveries: nextRecoveries,
        pending: nextPending,
      }),
      true,
    );
  }, [observedSubmissionIds]);

  function updateDraft(value: string, immediate = false) {
    draftRef.current = value;
    setDraft(value);
    updatePersistence(
      (current) =>
        editingRef.current
          ? {
              ...current,
              editing: { ...editingRef.current, text: value },
            }
          : { ...current, draft: value },
      immediate,
    );
    if (
      !immediate &&
      !writeComposerEntryJournal(persistenceScope, persisted.current, persistenceInstanceId)
    )
      setStorageWarning(STORAGE_ERROR);
  }

  function updateRecoveries(
    update: (current: PersistedComposerRecovery[]) => PersistedComposerRecovery[],
    immediate = false,
  ) {
    const next = update(recoveriesRef.current);
    recoveriesRef.current = next;
    setRecoveries(next);
    updatePersistence((current) => ({ ...current, recoveries: next }), immediate);
  }

  function updateEditing(next: PersistedComposerEditing | null, immediate = false) {
    editingRef.current = next;
    setEditing(next);
    updatePersistence((current) => ({ ...current, editing: next }), immediate);
  }

  function failureMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : "The request failed. Your text has been kept.";
  }

  async function run(name: string, callback: () => ActionResult, accepted?: () => ActionResult) {
    if (locked.current || unavailable) return;
    locked.current = true;
    setOperation(name);
    setError(null);
    try {
      await callback();
      if (ownsPersistence()) await accepted?.();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      locked.current = false;
      setOperation(null);
    }
  }

  async function runSubmission(
    name: string,
    callback: () => ActionResult,
    text: string,
    submission: TranscriptSubmission,
  ) {
    if (locked.current || unavailable) return;
    const pendingSubmission = {
      ...submission,
      text,
      pageId: composerPageId,
    };
    const durable = updatePersistence(
      (current) => ({
        ...current,
        draft: optimisticSubmit ? "" : current.draft,
        images: optimisticSubmit ? [] : current.images,
        pending: [...current.pending, pendingSubmission],
      }),
      true,
    );
    if (!durable) {
      setStorageWarning(STORAGE_SUBMIT_ERROR);
    }
    locked.current = true;
    setOperation(name);
    setSubmissionPending(true);
    setError(null);
    if (optimisticSubmit) {
      draftRef.current = "";
      setDraft("");
      imagesRef.current = [];
      setImages([]);
      input.current?.focus();
    }
    try {
      await callback();
      if (!optimisticSubmit && ownsPersistence()) {
        updateDraft("", true);
        updateImages([]);
        input.current?.focus();
      }
    } catch (cause) {
      if (!ownsPersistence()) return;
      const observed = observedIdsRef.current.has(submission.clientId);
      updatePersistence(
        (current) => ({
          ...current,
          pending: current.pending.filter((entry) => entry.clientId !== submission.clientId),
        }),
        true,
      );
      if (observed) return;
      const message = failureMessage(cause);
      if (optimisticSubmit) {
        if (draftRef.current.length === 0 && imagesRef.current.length === 0 && !imageSave.current) {
          updateDraft(text, true);
          updateImages(submission.images ?? []);
          setError(message);
        } else {
          updateRecoveries(
            (current) => [
              ...current,
              { clientId: submission.clientId, text, images: submission.images, error: message },
            ],
            true,
          );
        }
      } else setError(message);
    } finally {
      locked.current = false;
      setSubmissionPending(false);
      setOperation(null);
    }
  }

  async function finishEditing() {
    const current = editingRef.current;
    if (!current) return;
    await onEditingQueuedChange?.(null);
    if (!ownsPersistence()) return;
    updateEditing(null);
    updateDraft(current.savedDraft, true);
    updateImages(current.savedImages ?? []);
    input.current?.focus();
  }

  function submit(invertMode = false) {
    if (!canSubmit) return;
    const text = draft.trim();
    if (editing && onEditQueued) {
      const editState = editing;
      void run(
        "Saving…",
        async () => {
          if (editState.pageId !== composerPageId) {
            if (!onEditingQueuedChange)
              throw new Error("Reopen this queued edit before saving it.");
            await onEditingQueuedChange(editState.id);
            if (!ownsPersistence()) return;
            updateEditing({ ...editState, pageId: composerPageId }, true);
          }
          await onEditQueued(editState.id, text, imagesRef.current);
        },
        finishEditing,
      );
      return;
    }
    const submitMode = invertMode ? (mode === "steer" ? "queue" : "steer") : mode;
    const send = !active ? onSend : submitMode === "steer" ? onSteer : onQueue;
    if (!send) return;
    const submission: TranscriptSubmission = {
      clientId: createSubmissionClientId(),
      mode: active ? submitMode : "send",
      ...(images.length ? { images: [...images] } : {}),
    };
    void runSubmission(
      !active ? "Sending…" : submitMode === "steer" ? "Steering…" : "Queueing…",
      () => send(text, submission),
      text,
      submission,
    );
  }

  function edit(row: TranscriptQueuedMessage) {
    if (unavailable || row.disabled) return;
    void run(
      "Opening edit…",
      () => onEditingQueuedChange?.(row.id),
      () => {
        const next = {
          id: row.id,
          text: row.text,
          images: row.images ?? [],
          savedImages: editingRef.current?.savedImages ?? imagesRef.current,
          savedDraft: editingRef.current?.savedDraft ?? draftRef.current,
          pageId: composerPageId,
        };
        updateEditing(next);
        updateDraft(row.text, true);
        updateImages(row.images ?? []);
        input.current?.focus();
      },
    );
  }

  const working = active && reachable !== false;
  const activityLabel = working
    ? "Agent is working"
    : reachable === true
      ? "Agent is ready"
      : reachable === false
        ? "Agent is unavailable"
        : undefined;

  return (
    <div
      className={cn("agentchats-transcript transcript-composer", className)}
      data-always-show-send={alwaysShowSend || undefined}
    >
      <div
        className="transcript-composer__activity-line"
        data-active={working || undefined}
        data-reachable={reachable}
        role={activityLabel ? "status" : undefined}
        aria-label={activityLabel}
      >
        {activityLabel ? (
          <span className="transcript-composer__activity-label">{activityLabel}</span>
        ) : null}
      </div>
      <div className="transcript-composer__content">
        {queue.length > 0 ? (
          <section className="transcript-queue" aria-label="Queued messages">
            <p className="transcript-composer__label">Queued messages · {queue.length}</p>
            <ol>
              {queue.map((row) => (
                <li key={row.id} aria-label={`Queued message: ${row.text}`}>
                  <p className="transcript-queue__text">{row.text}</p>
                  {imageAttachments(row.images ?? [])}
                  {row.pausedReason ? (
                    <p className="transcript-queue__reason" role="status">
                      {row.pausedReason}
                    </p>
                  ) : null}
                  <div className="transcript-queue__actions">
                    {onSteerQueued ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          unavailable ||
                          row.disabled ||
                          !active ||
                          row.canSteer === false ||
                          editing?.id === row.id
                        }
                        onClick={() => void run("Steering…", () => onSteerQueued(row.id))}
                      >
                        Steer
                      </Button>
                    ) : null}
                    {onResumeQueued && row.pausedReason ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          unavailable ||
                          row.disabled ||
                          row.canResume !== true ||
                          editing?.id === row.id
                        }
                        onClick={() => void run("Resuming…", () => onResumeQueued(row.id))}
                      >
                        Resume
                      </Button>
                    ) : null}
                    {onEditQueued ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={unavailable || row.disabled}
                        onClick={() => edit(row)}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {onRemoveQueued ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={unavailable || row.disabled}
                        onClick={() =>
                          void run(
                            "Removing…",
                            () => onRemoveQueued(row.id),
                            () => {
                              if (editing?.id === row.id) return finishEditing();
                            },
                          )
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <form
          aria-label={label}
          data-file-drop={dragging || undefined}
          onDragOver={(event) => {
            if (!listReferenceFiles || disabled || (operation !== null && !submissionPending))
              return;
            if (
              !event.dataTransfer.types.some((type) =>
                ["Files", "text/uri-list", "text/plain"].includes(type),
              )
            )
              return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            if (!listReferenceFiles) return;
            setDragging(false);
            if (
              !event.dataTransfer.types.includes("Files") &&
              !transferredReferencePaths(event.dataTransfer).length
            )
              return;
            event.preventDefault();
            if (!disabled && (operation === null || submissionPending))
              acceptTransfer(event.dataTransfer);
          }}
          onPaste={(event) => {
            if (disabled || (operation !== null && !submissionPending)) return;
            const paths = transferredReferencePaths(event.clipboardData);
            if (paths.length && listReferenceFiles) {
              event.preventDefault();
              acceptTransfer(event.clipboardData);
              return;
            }
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            if (saveClipboardImage) {
              event.preventDefault();
              void pasteImages(files);
            } else if (listReferenceFiles) {
              event.preventDefault();
              acceptTransfer(event.clipboardData);
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {editing ? <p className="transcript-composer__label">Edit queued message</p> : null}
          {imageAttachments(images, true)}
          {savingImages ? (
            <p className="transcript-composer__image-status" role="status">
              Saving clipboard image…{" "}
              <button
                type="button"
                onClick={() => {
                  imageSave.current?.abort();
                  imageSave.current = null;
                  setSavingImages(false);
                  setError("Image paste cancelled. Any images already attached have been kept.");
                }}
              >
                Cancel paste
              </button>
            </p>
          ) : null}
          <InputGroup>
            <InputGroupTextarea
              ref={input}
              id={inputId}
              aria-label={editing ? "Edit queued message" : label}
              aria-describedby={
                error || storageWarning || recoveries.length > 0 ? `${inputId}-error` : undefined
              }
              aria-invalid={Boolean(error || recoveries.length > 0)}
              aria-autocomplete="none"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              placeholder={placeholder}
              spellCheck={false}
              value={draft}
              disabled={disabled}
              readOnly={
                optimisticSubmit
                  ? operation !== null && !submissionPending
                  : pending || operation !== null || stopping
              }
              onChange={(event) => {
                updateDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                const invert = active && event.shiftKey && (event.metaKey || event.ctrlKey);
                if (event.shiftKey && !invert) return;
                event.preventDefault();
                submit(invert);
              }}
            />
            <InputGroupAddon align="block-end">
              {editing ? (
                <InputGroupButton
                  disabled={unavailable}
                  onClick={() => void run("Closing edit…", finishEditing)}
                >
                  Cancel edit
                </InputGroupButton>
              ) : onSteer || onQueue ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<InputGroupButton className="transcript-composer__mode" />}
                    disabled={unavailable}
                    aria-label="Follow-up behavior"
                  >
                    {mode === "steer" ? "Steer" : "Queue"} while running
                    <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    portalClassName="agentchats-transcript"
                    side="top"
                    className="transcript-composer__menu"
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>While Agent is running</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={mode}
                        onValueChange={(value) => {
                          if (value !== "steer" && value !== "queue") return;
                          setLocalMode(value);
                          updatePersistence(
                            (current) => ({
                              ...current,
                              followUpMode: value,
                            }),
                            true,
                          );
                          onFollowUpModeChange?.(value);
                        }}
                      >
                        <DropdownMenuRadioItem value="steer" disabled={!onSteer} closeOnClick>
                          Steer current turn
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="queue" disabled={!onQueue} closeOnClick>
                          Queue for next turn
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {listReferenceFiles ? (
                <InputGroupButton
                  type="button"
                  aria-label="Reference a file"
                  title="Insert a local file path"
                  disabled={disabled || (operation !== null && !submissionPending)}
                  onClick={() => {
                    captureSelection();
                    setPickerOpen(true);
                  }}
                >
                  <PaperclipIcon aria-hidden="true" />
                </InputGroupButton>
              ) : null}
              <span className="transcript-composer__status" role="status">
                {stopping && onInterrupt ? "Stopping…" : (operation ?? (pending ? "Sending…" : ""))}
              </span>
              {alwaysShowSend ? (
                <InputGroupButton type="submit" size="sm" variant="default" disabled={!canSubmit}>
                  <ArrowUpIcon data-icon="inline-start" aria-hidden="true" />
                  {editing ? "Save queued message" : "Send"}
                </InputGroupButton>
              ) : (showStop || stopping) && !onInterrupt ? null : showStop || stopping ? (
                <InputGroupButton
                  size="sm"
                  variant="secondary"
                  disabled={unavailable || !onInterrupt}
                  aria-label="Stop Agent"
                  onClick={() => {
                    if (onInterrupt) void run("Stopping…", onInterrupt);
                  }}
                >
                  <SquareIcon data-icon="inline-start" aria-hidden="true" />
                  Stop
                </InputGroupButton>
              ) : (
                <InputGroupButton type="submit" size="sm" variant="default" disabled={!canSubmit}>
                  <ArrowUpIcon data-icon="inline-start" aria-hidden="true" />
                  {actionLabel}
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
          {error || storageWarning || recoveries.length > 0 ? (
            <div className="transcript-composer__error" id={`${inputId}-error`}>
              {error ? <p role="alert">{error}</p> : null}
              {storageWarning ? <p role="alert">{storageWarning}</p> : null}
              {recoveries.map((recovery) => (
                <div className="transcript-composer__recovery" key={recovery.clientId} role="alert">
                  <div>
                    <p className="transcript-composer__recovery-error">{recovery.error}</p>
                    <p>{recovery.text}</p>
                    {imageAttachments(recovery.images ?? [])}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={savingImages}
                    onClick={() => {
                      if (
                        imagesRef.current.length + (recovery.images?.length ?? 0) >
                        MAX_LOCAL_IMAGES
                      ) {
                        setError(
                          "Remove some draft images before restoring this message (4 images maximum).",
                        );
                        return;
                      }
                      updateImages([...imagesRef.current, ...(recovery.images ?? [])]);
                      const nextDraft =
                        draftRef.current.length > 0
                          ? `${draftRef.current}\n\n${recovery.text}`
                          : recovery.text;
                      draftRef.current = nextDraft;
                      setDraft(nextDraft);
                      const nextRecoveries = recoveriesRef.current.filter(
                        (entry) => entry.clientId !== recovery.clientId,
                      );
                      recoveriesRef.current = nextRecoveries;
                      setRecoveries(nextRecoveries);
                      updatePersistence(
                        (current) =>
                          editingRef.current
                            ? {
                                ...current,
                                editing: {
                                  ...editingRef.current,
                                  text: nextDraft,
                                },
                                recoveries: nextRecoveries,
                              }
                            : {
                                ...current,
                                draft: nextDraft,
                                recoveries: nextRecoveries,
                              },
                        true,
                      );
                      input.current?.focus();
                    }}
                  >
                    {recovery.images?.length ? "Restore sent message" : "Restore sent text"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      updateRecoveries(
                        (current) =>
                          current.filter((entry) => entry.clientId !== recovery.clientId),
                        true,
                      )
                    }
                  >
                    {recovery.images?.length ? "Dismiss sent message" : "Dismiss sent text"}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </form>
      </div>
      {pickerOpen && listReferenceFiles ? (
        <FileReferencePicker
          listFiles={listReferenceFiles}
          onSelect={(path) => insertReferences([path])}
          onClose={() => {
            setPickerOpen(false);
            requestAnimationFrame(() => input.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}
