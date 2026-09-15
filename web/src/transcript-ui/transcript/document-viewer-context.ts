import { createContext, type MouseEvent, useContext } from "react";

export interface DocumentRequest {
  /** The link target exactly as rendered from Markdown. */
  href: string;
  /** The canonical path of the document containing a relative link. */
  base?: string;
}

export interface LoadedDocument {
  title: string;
  /** Canonical display path returned by the host loader. */
  path: string;
  content: string;
}

export type DocumentLoader = (
  request: DocumentRequest & { signal: AbortSignal },
) => Promise<LoadedDocument>;

export type DocumentCandidate = (request: DocumentRequest) => boolean;

const markdownPath = /(?:^|\/)[^?#]+\.(?:md|markdown)(?::[1-9]\d*(?::[1-9]\d*)?)?(?:#[^?]*)?$/i;

/** A deliberately narrow default. The host remains the authority for readable roots. */
export function isLocalMarkdownHref({ href }: DocumentRequest): boolean {
  const candidate = href.trim();
  if (!candidate || candidate.startsWith("#")) return false;
  if (/^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(candidate)) return false;
  if (/^wiki:/i.test(candidate)) return true;
  if (/^file:/i.test(candidate)) {
    try {
      return markdownPath.test(new URL(candidate).pathname);
    } catch {
      return false;
    }
  }
  if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(candidate)) return false;
  return markdownPath.test(candidate);
}

interface DocumentViewerContextValue {
  base?: string;
  canOpen: DocumentCandidate;
  open: (request: DocumentRequest, opener: HTMLElement) => void;
}

export const DocumentViewerContext = createContext<DocumentViewerContextValue | null>(null);

export function useDocumentViewerLink() {
  return useContext(DocumentViewerContext);
}

export function activateDocumentLink(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  context: DocumentViewerContextValue,
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const request = { href, base: context.base };
  if (!context.canOpen(request)) return;
  event.preventDefault();
  context.open(request, event.currentTarget);
}
