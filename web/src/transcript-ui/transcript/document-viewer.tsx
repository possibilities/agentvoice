"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ArrowLeftIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownContent } from "../components/chat/markdown-content";
import {
  type DocumentCandidate,
  type DocumentLoader,
  type DocumentRequest,
  DocumentViewerContext,
  isLocalMarkdownHref,
  type LoadedDocument,
} from "./document-viewer-context";
import { focusComposerAtEnd } from "./focus-composer";

export type {
  DocumentCandidate,
  DocumentLoader,
  DocumentRequest,
  LoadedDocument,
} from "./document-viewer-context";

interface DocumentEntry {
  request: DocumentRequest;
  status: "loading" | "ready" | "error";
  document?: LoadedDocument;
  error?: string;
  attempt: number;
}

interface DocumentViewState {
  resetKey?: string;
  history: readonly DocumentEntry[];
}

const documentHistoryLimit = 32;

export interface DocumentViewerProviderProps {
  children: ReactNode;
  load: DocumentLoader;
  /** Further restrict which local Markdown links the host wants to handle. */
  canOpen?: DocumentCandidate;
  /** Close an open document when its host-owned reading scope changes. */
  resetKey?: string;
}

function displayName(href: string) {
  const clean = href.split(/[?#]/, 1)[0]!.replace(/\/$/, "");
  const name = clean.split("/").at(-1);
  return name || "Document";
}

function requestFragment(href: string) {
  const index = href.indexOf("#");
  if (index < 0) return null;
  try {
    return decodeURIComponent(href.slice(index + 1));
  } catch {
    return href.slice(index + 1);
  }
}

function splitFrontmatter(content: string) {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]{0,16384}?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    content,
  );
  if (!match || match[1]!.split(/\r?\n/).length > 200) return { body: content };
  return {
    body: content.slice(match[0].length),
    frontmatter: match[0].trimEnd(),
  };
}

function DocumentArticle({ document }: { document: LoadedDocument }) {
  const source = useMemo(() => splitFrontmatter(document.content), [document.content]);
  return (
    <article className="document-viewer__article">
      {source.frontmatter ? (
        <details className="document-viewer__metadata">
          <summary>Document metadata</summary>
          <pre>{source.frontmatter}</pre>
        </details>
      ) : null}
      <MarkdownContent content={source.body} />
    </article>
  );
}

/**
 * Adds an opt-in Markdown document reader to descendant transcript links.
 * Loading, path authorization, and transport remain host-owned.
 */
export function DocumentViewerProvider({
  children,
  load,
  canOpen = isLocalMarkdownHref,
  resetKey,
}: DocumentViewerProviderProps) {
  const [view, setView] = useState<DocumentViewState>(() => ({
    resetKey,
    history: [],
  }));
  let activeView = view;
  if (view.resetKey !== resetKey) {
    activeView = { resetKey, history: [] };
    setView(activeView);
  }
  const history = activeView.history;
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const current = history.at(-1);

  const accepts = useCallback(
    (request: DocumentRequest) => isLocalMarkdownHref(request) && canOpen(request),
    [canOpen],
  );

  const open = useCallback(
    (request: DocumentRequest, trigger: HTMLElement) => {
      if (history.length === 0) opener.current = trigger;
      setView((state) => {
        const previous = state.history.at(-1);
        if (previous?.request.href === request.href && previous.request.base === request.base)
          return state;
        const entry: DocumentEntry = {
          request,
          status: "loading",
          attempt: 0,
        };
        return {
          ...state,
          history: [...state.history, entry].slice(-documentHistoryLimit),
        };
      });
    },
    [history.length],
  );

  const close = useCallback(() => setView((state) => ({ ...state, history: [] })), []);
  const back = useCallback(
    () =>
      setView((state) => ({
        ...state,
        history: state.history.slice(0, -1),
      })),
    [],
  );
  const retry = useCallback(() => {
    setView((state) => {
      const entry = state.history.at(-1);
      if (!entry) return state;
      return {
        ...state,
        history: [
          ...state.history.slice(0, -1),
          { ...entry, status: "loading", error: undefined, attempt: entry.attempt + 1 },
        ],
      };
    });
  }, []);

  useEffect(() => {
    if (!current || current.status !== "loading") return;
    const controller = new AbortController();
    const { request, attempt } = current;
    void load({ ...request, signal: controller.signal }).then(
      (document) => {
        if (controller.signal.aborted) return;
        setView((state) => {
          const entry = state.history.at(-1);
          if (!entry || entry.request !== request || entry.attempt !== attempt) return state;
          return {
            ...state,
            history: [...state.history.slice(0, -1), { ...entry, status: "ready", document }],
          };
        });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        const error =
          reason instanceof Error && reason.message.trim()
            ? reason.message
            : "The document could not be loaded.";
        setView((state) => {
          const entry = state.history.at(-1);
          if (!entry || entry.request !== request || entry.attempt !== attempt) return state;
          return {
            ...state,
            history: [...state.history.slice(0, -1), { ...entry, status: "error", error }],
          };
        });
      },
    );
    return () => controller.abort();
  }, [current, load]);

  useEffect(() => {
    if (current?.status !== "ready") return;
    const fragment = requestFragment(current.request.href);
    if (!fragment) {
      content.current?.scrollTo({ top: 0 });
      return;
    }
    const target = content.current?.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`);
    target?.scrollIntoView({ block: "start" });
  }, [current]);

  const value = useMemo(
    () => ({
      canOpen: accepts,
      open,
    }),
    [accepts, open],
  );
  const documentValue = useMemo(
    () => ({ ...value, base: current?.document?.path }),
    [current?.document?.path, value],
  );
  const hasBack = history.length > 1;
  const title =
    current?.document?.title || (current ? displayName(current.request.href) : "Document");
  const displayPath = current?.document?.path || current?.request.href;
  const showSource = Boolean(
    current?.document?.path && current.document.path !== current.request.href,
  );

  return (
    <DocumentViewerContext.Provider value={value}>
      {children}
      <Dialog.Root open={Boolean(current)} onOpenChange={(next) => !next && close()}>
        <Dialog.Portal className="agentchats-transcript">
          <Dialog.Backdrop className="document-viewer__backdrop" />
          <Dialog.Popup
            className="document-viewer__popup"
            data-slot="document-viewer"
            finalFocus={() => opener.current}
          >
            <header className="document-viewer__header">
              <div className="document-viewer__heading">
                <Dialog.Title className="document-viewer__title">{title}</Dialog.Title>
                <Dialog.Description className="document-viewer__description">
                  <span className="document-viewer__path" title={displayPath}>
                    {displayPath}
                  </span>
                  {showSource ? (
                    <span className="document-viewer__source">
                      Opened from {current?.request.href}
                    </span>
                  ) : null}
                </Dialog.Description>
                <details className="document-viewer__provenance">
                  <summary>Source</summary>
                  <dl>
                    <div>
                      <dt>Path</dt>
                      <dd>{displayPath}</dd>
                    </div>
                    <div>
                      <dt>Link target</dt>
                      <dd>{current?.request.href}</dd>
                    </div>
                  </dl>
                </details>
              </div>
              <div className="document-viewer__actions">
                {hasBack ? (
                  <button type="button" onClick={back}>
                    <ArrowLeftIcon aria-hidden="true" />
                    Back
                  </button>
                ) : null}
                <Dialog.Close
                  aria-label="Close document"
                  onClick={(event) =>
                    focusComposerAtEnd(event.currentTarget, { allowRestoredFocus: true })
                  }
                >
                  <XIcon aria-hidden="true" />
                  <span>Close</span>
                </Dialog.Close>
              </div>
            </header>
            <div
              className="document-viewer__content"
              data-slot="document-viewer-content"
              ref={content}
            >
              {current?.status === "loading" ? (
                <div className="document-viewer__status" role="status">
                  <span className="document-viewer__pulse" aria-hidden="true" />
                  Loading document…
                </div>
              ) : null}
              {current?.status === "error" ? (
                <div className="document-viewer__error" role="alert">
                  <p>{current.error}</p>
                  <button type="button" onClick={retry}>
                    <RotateCcwIcon aria-hidden="true" />
                    Retry
                  </button>
                </div>
              ) : null}
              {current?.status === "ready" && current.document ? (
                <DocumentViewerContext.Provider value={documentValue}>
                  <DocumentArticle document={current.document} />
                </DocumentViewerContext.Provider>
              ) : null}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </DocumentViewerContext.Provider>
  );
}
