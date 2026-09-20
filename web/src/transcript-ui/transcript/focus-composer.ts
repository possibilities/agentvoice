const blockingSurface = '[role="dialog"], [role="menu"]';

function visible(element: Element) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

export function focusComposerAtEnd(
  source?: Element | null,
  { allowRestoredFocus = false }: { allowRestoredFocus?: boolean } = {},
) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const document = source?.ownerDocument ?? globalThis.document;
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[data-composer-focus-sink="true"]',
      );
      if (
        !textarea ||
        textarea.disabled ||
        textarea.readOnly ||
        textarea.dataset.composerReachable !== "true" ||
        textarea.dataset.composing === "true" ||
        [...document.querySelectorAll(blockingSurface)].some(visible)
      )
        return;
      const selection = document.defaultView?.getSelection();
      if (selection && !selection.isCollapsed) return;
      const active = document.activeElement;
      const activeTranscript =
        active instanceof Element &&
        active.matches('[role="region"][aria-label$="transcript"]') &&
        (!source || active.contains(source));
      if (
        active &&
        active !== document.body &&
        active !== source &&
        active !== textarea &&
        !activeTranscript &&
        !(allowRestoredFocus && source?.isConnected === false)
      )
        return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }),
  );
}
