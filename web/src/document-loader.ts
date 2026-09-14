import type { DocumentLoader } from "@agentchats/transcript/react";

/** The host authorizes linked Markdown; the browser never chooses a filesystem root. */
export const loadDocument: DocumentLoader = async ({ href, base, signal }) => {
  const response = await fetch("/api/document", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ href, ...(base ? { base } : {}) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: "no-store",
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : "This document is unavailable. Try again when AgentVoice is reachable.";
    throw new Error(message);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("content" in value) ||
    typeof value.content !== "string"
  )
    throw new Error("The document response could not be read.");
  return { title: value.title, path: value.path, content: value.content };
};
