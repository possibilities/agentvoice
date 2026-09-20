import { cn } from "cn";
import { XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  CLIPBOARD_IMAGE_MIME_TYPES,
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_LOCAL_IMAGES,
} from "../../../../src/attachment/image-contract";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupTextarea } from "../components/ui/input-group";
import type { ComposerImage, SaveClipboardImage } from "./composer-images";
import {
  cacheComposerState,
  composerPageId,
  loadComposerState,
  type PersistedComposerRecovery,
  type PersistedComposerState,
  writeComposerEntryJournal,
  writeComposerState,
} from "./composer-persistence";
import { insertFileReferences, transferredReferencePaths } from "./file-references";

type ActionResult = void | Promise<void>;

export interface TranscriptSubmission {
  /** Host-visible identity for optimistic rendering and exact transport reconciliation. */
  clientId: string;
  mode: "send" | "steer";
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
  /** Clear accepted input before awaiting the callback and retain explicit failure recovery. */
  optimisticSubmit?: boolean;
  /** Stable opaque workspace + thread + lane identity for browser draft recovery. */
  persistenceScope?: string;
  /** Stable single-window host identity. Omit in ordinary multi-tab browsers. */
  persistenceInstanceId?: string;
  /** Exact client IDs already present in the authoritative transcript. */
  observedSubmissionIds?: readonly string[];
  onSend?: (text: string, submission: TranscriptSubmission) => ActionResult;
  onSteer?: (text: string, submission: TranscriptSubmission) => ActionResult;
  /** Host-owned FIFO. This component never drains or retries it automatically. */
  queue?: readonly TranscriptQueuedMessage[];
  onRemoveQueued?: (id: string) => ActionResult;
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
  optimisticSubmit = false,
  persistenceScope,
  persistenceInstanceId,
  observedSubmissionIds = EMPTY_SUBMISSION_IDS,
  onSend,
  onSteer,
  queue = [],
  onRemoveQueued,
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
  const [dragging, setDragging] = useState(false);
  const locked = useRef(false);
  const legacyEditing = loaded.state.editing;
  const initialState: PersistedComposerState = legacyEditing
    ? {
        ...loaded.state,
        draft: legacyEditing.savedDraft,
        images: legacyEditing.savedImages ?? [],
        editing: null,
        followUpMode: "steer",
      }
    : { ...loaded.state, followUpMode: "steer" };
  const persisted = useRef<PersistedComposerState>(initialState);
  const persistenceTimer = useRef<number | null>(null);
  const persistenceDirty = useRef(
    loaded.changed || legacyEditing !== null || loaded.state.followUpMode !== "steer",
  );
  const draftRef = useRef(initialState.draft);
  const imagesRef = useRef<ComposerImage[]>(initialState.images ?? []);
  const [images, setImages] = useState(imagesRef.current);
  const [draft, setDraft] = useState(initialState.draft);
  const [operation, setOperation] = useState<string | null>(null);
  const [submissionPending, setSubmissionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(
    loaded.storageAvailable ? null : STORAGE_ERROR,
  );
  const recoveriesRef = useRef(loaded.state.recoveries);
  const [recoveries, setRecoveries] = useState(loaded.state.recoveries);
  const observedIdsRef = useRef(new Set(observedSubmissionIds));
  const unavailable =
    disabled || actionsDisabled || pending || operation !== null || stopping || savingImages;
  const action = active ? onSteer : onSend;
  const canSubmit =
    (draft.trim().length > 0 || images.length > 0) && !unavailable && Boolean(action);

  useEffect(() => () => imageSave.current?.abort(), []);

  function updateImages(next: ComposerImage[], immediate = true) {
    imagesRef.current = next;
    setImages(next);
    updatePersistence((current) => ({ ...current, images: next, editing: null }), immediate);
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
        setError(
          "Paste a PNG, JPEG, WebP or GIF image. Drop other local files to insert their paths.",
        );
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
        "This browser did not provide a full local file path. Paste an absolute path, or paste a clipboard image to attach it instead.",
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
    updatePersistence((current) => ({ ...current, draft: value, editing: null }), immediate);
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

  function submit() {
    if (!canSubmit) return;
    const text = draft.trim();
    const send = active ? onSteer : onSend;
    if (!send) return;
    const submission: TranscriptSubmission = {
      clientId: createSubmissionClientId(),
      mode: active ? "steer" : "send",
      ...(images.length ? { images: [...images] } : {}),
    };
    void runSubmission(
      active ? "Steering…" : "Sending…",
      () => send(text, submission),
      text,
      submission,
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
    <div className={cn("agentchats-transcript transcript-composer", className)}>
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
                    {onRemoveQueued ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={unavailable || row.disabled}
                        onClick={() => void run("Removing…", () => onRemoveQueued(row.id))}
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
            if (disabled || (operation !== null && !submissionPending)) return;
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
            if (paths.length) {
              event.preventDefault();
              acceptTransfer(event.clipboardData);
              return;
            }
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            if (saveClipboardImage) {
              event.preventDefault();
              void pasteImages(files);
            } else {
              event.preventDefault();
              acceptTransfer(event.clipboardData);
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
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
          <p className="transcript-composer__instructions" id={`${inputId}-instructions`}>
            Press Enter to {active ? "steer the current turn" : "send"}. Press Shift+Enter for a new
            line. Drop local files to insert their paths, or paste images to attach them.
          </p>
          <InputGroup>
            <InputGroupTextarea
              ref={input}
              id={inputId}
              aria-label={label}
              aria-describedby={`${inputId}-instructions${
                error || storageWarning || recoveries.length > 0 ? ` ${inputId}-error` : ""
              }`}
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
                if (event.shiftKey) return;
                event.preventDefault();
                submit();
              }}
            />
          </InputGroup>
          {operation || pending || stopping ? (
            <p className="transcript-composer__status" role="status">
              {stopping ? "Stopping…" : (operation ?? "Sending…")}
            </p>
          ) : null}
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
                        (current) => ({
                          ...current,
                          draft: nextDraft,
                          editing: null,
                          recoveries: nextRecoveries,
                        }),
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
    </div>
  );
}
