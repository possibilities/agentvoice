"use client";

import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import {
  type ReactNode,
  type UIEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../components/ui/button";

const END_THRESHOLD = 64;
const VISIBILITY_EPSILON = 1;

type WindowedRow<T> =
  | { key: "slot:header"; kind: "slot"; content: ReactNode }
  | { key: "slot:empty"; kind: "slot"; content: ReactNode }
  | { key: `block:${string}`; kind: "block"; block: T }
  | { key: "slot:footer"; kind: "slot"; content: ReactNode };

interface ReadingAnchor {
  key: string;
  offset: number;
}

export interface WindowedTranscriptProps<T extends { id: string }> {
  blocks: readonly T[];
  /** Exact visible message IDs, including messages grouped into one block. */
  messageIds: readonly string[];
  /** Newly appended prose-message IDs eligible for the unread count. */
  countedMessageIds: readonly string[];
  renderBlock: (block: T) => ReactNode;
  /** Follow the bottom until the reader scrolls away. */
  follow: boolean;
  /** Show the unread count and jump control while away from the end. */
  showJumpToLatest: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  viewportId?: string;
  "aria-label"?: string;
}

function distanceFromEnd(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}

function captureReadingAnchor(element: HTMLElement): ReadingAnchor | null {
  const viewportTop = element.getBoundingClientRect().top;
  const rendered = element.querySelectorAll<HTMLElement>("[data-windowed-row-key]");
  for (const row of rendered) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > viewportTop) {
      return {
        key: row.dataset.windowedRowKey ?? "",
        offset: bounds.top - viewportTop,
      };
    }
  }
  return null;
}

function restoreReadingAnchor(element: HTMLElement, anchor: ReadingAnchor) {
  const viewportBounds = element.getBoundingClientRect();
  const rendered = element.querySelectorAll<HTMLElement>("[data-windowed-row-key]");
  for (const row of rendered) {
    if (row.dataset.windowedRowKey !== anchor.key) continue;
    const rowBounds = row.getBoundingClientRect();
    // Direct DOM updates can leave a keyed node mounted at its old transform
    // for one frame after indexes shift. It is not a usable anchor until the
    // virtualizer positions it back in the viewport.
    if (rowBounds.bottom <= viewportBounds.top || rowBounds.top >= viewportBounds.bottom) {
      return false;
    }
    element.scrollTop += rowBounds.top - viewportBounds.top - anchor.offset;
    return true;
  }
  return false;
}

/**
 * A bounded, variable-height transcript viewport. The caller owns presentation
 * and disclosure state; this component owns only virtualization and following.
 */
export function WindowedTranscript<T extends { id: string }>({
  blocks,
  messageIds,
  countedMessageIds,
  renderBlock,
  follow,
  showJumpToLatest,
  header,
  footer,
  empty,
  viewportId,
  "aria-label": label = "Human / Agent transcript",
}: WindowedTranscriptProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const awayRef = useRef(false);
  const followRef = useRef(follow);
  const stickToEndRef = useRef(true);
  const initializingRef = useRef(true);
  const anchorRef = useRef<ReadingAnchor | null>(null);
  const restoringAnchorRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const anchorFrameRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const edgeFrameRef = useRef<number | null>(null);
  const updateEdgeRef = useRef<() => void>(() => {});
  const lastIndexRef = useRef(0);
  const lastScrollOffsetRef = useRef(0);
  const frozenOffsetRef = useRef<number | null>(null);
  const priorFollowRef = useRef(follow);
  const lastViewportHeightRef = useRef(0);
  const lastEndGapRef = useRef(0);
  const resizePinRef = useRef(false);
  const readingIntentUntilRef = useRef(0);
  const towardEndIntentUntilRef = useRef(0);
  const pointerReadingRef = useRef(false);
  const touchYRef = useRef<number | null>(null);
  const [away, setAway] = useState(false);
  const [tailOffscreen, setTailOffscreen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [initializing, setInitializing] = useState(true);
  const [startPadding, setStartPadding] = useState(24);
  const [endPadding, setEndPadding] = useState(48);
  const [rowGap, setRowGap] = useState(24);
  const priorIdsRef = useRef({ ordered: messageIds, set: new Set(messageIds) });
  const pendingCountedIdsRef = useRef(new Set<string>());
  const unreadFrameRef = useRef<number | null>(null);

  followRef.current = follow;
  if (!follow && !initializingRef.current) {
    stickToEndRef.current = false;
    if (priorFollowRef.current || frozenOffsetRef.current == null) {
      frozenOffsetRef.current = lastScrollOffsetRef.current;
    }
  } else if (follow) {
    frozenOffsetRef.current = null;
  }
  priorFollowRef.current = follow;

  const rows = useMemo(() => {
    const next: WindowedRow<T>[] = [];
    if (header != null) {
      next.push({ key: "slot:header", kind: "slot", content: header });
    }
    if (blocks.length === 0 && empty != null) {
      next.push({ key: "slot:empty", kind: "slot", content: empty });
    }
    for (const block of blocks) {
      next.push({
        key: `block:${block.id}`,
        kind: "block",
        block,
      });
    }
    if (footer != null) {
      next.push({ key: "slot:footer", kind: "slot", content: footer });
    }
    return next;
  }, [blocks, empty, footer, header]);
  lastIndexRef.current = Math.max(0, rows.length - 1);

  const rowKeys = useMemo<readonly string[]>(() => rows.map((row) => row.key), [rows]);
  const priorRowKeysRef = useRef(rowKeys);
  const priorRowsRef = useRef(rows);
  const rowsChanged = rows !== priorRowsRef.current;
  const keysChanged =
    rowKeys.length !== priorRowKeysRef.current.length ||
    rowKeys.some((key, index) => key !== priorRowKeysRef.current[index]);
  if (keysChanged && awayRef.current && !restoringAnchorRef.current) {
    // Read the bounded mounted window before React commits the new keyed rows.
    // A queued scroll/measurement capture may be one layout frame behind.
    const currentAnchor = viewportRef.current
      ? captureReadingAnchor(viewportRef.current)
      : anchorRef.current;
    if (currentAnchor && rowKeys.includes(currentAnchor.key)) {
      anchorRef.current = currentAnchor;
      restoringAnchorRef.current = true;
    }
  }

  const getItemKey = useCallback((index: number) => rows[index]?.key ?? `missing:${index}`, [rows]);
  const focusedRowIndex = focusedRowKey ? rows.findIndex((row) => row.key === focusedRowKey) : -1;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedRowIndex >= 0 && !indexes.includes(focusedRowIndex)) {
        indexes.push(focusedRowIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [focusedRowIndex],
  );

  const queueAnchorCapture = useCallback(() => {
    if (anchorFrameRef.current != null) return;
    anchorFrameRef.current = requestAnimationFrame(() => {
      anchorFrameRef.current = null;
      const element = viewportRef.current;
      if (element && awayRef.current && !restoringAnchorRef.current) {
        anchorRef.current = captureReadingAnchor(element);
      }
    });
  }, []);

  const queueEdgeUpdate = useCallback(() => {
    if (edgeFrameRef.current != null) return;
    edgeFrameRef.current = requestAnimationFrame(() => {
      edgeFrameRef.current = null;
      updateEdgeRef.current();
    });
  }, []);

  const queueScrollToEnd = useCallback(
    (instance: Virtualizer<HTMLDivElement, HTMLDivElement>) => {
      if (scrollFrameRef.current != null || rows.length === 0) return;
      let attempts = 0;
      let stableFrames = 0;
      const settleEnd = () => {
        attempts++;
        if (!stickToEndRef.current && !initializingRef.current) {
          scrollFrameRef.current = null;
          return;
        }
        const element = viewportRef.current;
        if (!element) {
          scrollFrameRef.current = null;
          return;
        }
        // Direct DOM sizing can trail a replaced snapshot by a layout frame.
        // A still-short scrollHeight must not settle before the new logical end.
        const logicalEnd = Math.max(0, instance.getTotalSize() - element.clientHeight);
        if (distanceFromEnd(element) <= 1 && Math.abs(element.scrollTop - logicalEnd) <= 1) {
          stableFrames++;
        } else {
          stableFrames = 0;
          instance.scrollToIndex(lastIndexRef.current, {
            align: "end",
            behavior: "auto",
          });
          element.scrollTop = element.scrollHeight;
        }
        if (attempts < 60 && stableFrames < 2) {
          scrollFrameRef.current = requestAnimationFrame(settleEnd);
        } else {
          if (stableFrames < 2) element.scrollTop = element.scrollHeight;
          scrollFrameRef.current = null;
          resizePinRef.current = false;
          lastViewportHeightRef.current = element.clientHeight;
          lastEndGapRef.current = distanceFromEnd(element);
          if (initializingRef.current) {
            initializingRef.current = false;
            stickToEndRef.current = followRef.current;
            awayRef.current = false;
            lastScrollOffsetRef.current = element.scrollTop;
            if (!followRef.current) frozenOffsetRef.current = element.scrollTop;
            setAway(false);
            setInitializing(false);
          }
        }
      };
      scrollFrameRef.current = requestAnimationFrame(settleEnd);
    },
    [rows.length],
  );

  // TanStack Virtual intentionally exposes a mutable controller; React Compiler
  // leaves this component unmemoized while the controller owns scroll state.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => (rows[index]?.kind === "slot" ? 96 : 180),
    getItemKey,
    rangeExtractor,
    paddingStart: startPadding,
    paddingEnd: endPadding,
    gap: rowGap,
    overscan: 6,
    useFlushSync: false,
    directDomUpdates: true,
    onChange(instance, sync) {
      if (awayRef.current && !restoringAnchorRef.current) {
        queueAnchorCapture();
      }
      if (!sync) queueEdgeUpdate();
      if (!sync && (stickToEndRef.current || initializingRef.current)) {
        queueScrollToEnd(instance);
      }
    },
  });

  // Dynamic markdown and tool disclosures can resize above the reading point.
  // Always retain that point; following rows are corrected to the end above.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.start < (instance.scrollOffset ?? 0) + instance.scrollAdjustments;

  const setContentElement = useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element;
      virtualizer.containerRef(element);
    },
    [virtualizer],
  );

  const logicalTailIsOffscreen = useCallback(() => {
    const element = viewportRef.current;
    if (!element || rows.length === 0) return false;
    const viewportEnd = (virtualizer.scrollOffset ?? element.scrollTop) + element.clientHeight;
    const lastIndex = rows.length - 1;
    const measuredTail = virtualizer
      .getVirtualItems()
      .find((item) => item.index === lastIndex)?.end;
    // The end padding is breathing room, not unseen transcript content.
    const tailEnd = measuredTail ?? Math.max(0, virtualizer.getTotalSize() - endPadding);
    return tailEnd > viewportEnd + VISIBILITY_EPSILON;
  }, [endPadding, rows.length, virtualizer]);

  const queueUnreadMeasurement = useCallback(() => {
    if (unreadFrameRef.current != null || pendingCountedIdsRef.current.size === 0) return;
    let attempts = 0;
    let stableFrames = 0;
    let priorGeometry = "";
    // New virtual rows first carry estimates. Count only after their measured
    // range settles, so a row that still fits is treated as already seen.
    const settleUnread = () => {
      attempts++;
      const element = viewportRef.current;
      if (!element) {
        unreadFrameRef.current = null;
        return;
      }
      const virtualItems = virtualizer.getVirtualItems();
      const geometry = `${virtualizer.getTotalSize()}:${virtualItems
        .map((item) => `${item.index}:${item.start}:${item.end}`)
        .join(",")}`;
      stableFrames = geometry === priorGeometry ? stableFrames + 1 : 0;
      priorGeometry = geometry;
      if (attempts < 12 && stableFrames < 2) {
        unreadFrameRef.current = requestAnimationFrame(settleUnread);
        return;
      }

      unreadFrameRef.current = null;
      const viewportEnd = (virtualizer.scrollOffset ?? element.scrollTop) + element.clientHeight;
      // A retained focused row can sit beyond the ordinary visible window.
      const lastVisibleIndex =
        virtualItems.findLast((item) => item.start < viewportEnd)?.index ?? -1;
      const byIndex = new Map(virtualItems.map((item) => [item.index, item]));
      let addedUnread = 0;
      for (const id of pendingCountedIdsRef.current) {
        const index = rowKeys.indexOf(`block:${id}`);
        const item = byIndex.get(index);
        if (
          index >= 0 &&
          ((item && item.end > viewportEnd + VISIBILITY_EPSILON) ||
            (!item && index > lastVisibleIndex))
        ) {
          addedUnread++;
        }
      }
      pendingCountedIdsRef.current.clear();
      const tailIsOffscreen = logicalTailIsOffscreen();
      setTailOffscreen(tailIsOffscreen);
      if (addedUnread > 0 && tailIsOffscreen) {
        setUnread((current) => current + addedUnread);
      }
    };
    unreadFrameRef.current = requestAnimationFrame(settleUnread);
  }, [logicalTailIsOffscreen, rowKeys, virtualizer]);

  const releaseResizePin = useCallback(() => {
    if (!resizePinRef.current) return;
    resizePinRef.current = false;
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }, []);

  const markReadingIntent = useCallback(() => {
    readingIntentUntilRef.current = performance.now() + 1_000;
    releaseResizePin();
  }, [releaseResizePin]);

  const disengageEndFollow = useCallback(() => {
    const element = viewportRef.current;
    // Gestures on a fully visible conversation cannot move the reading position.
    if (!element || element.scrollHeight <= element.clientHeight) return;
    markReadingIntent();
    towardEndIntentUntilRef.current = 0;
    if (initializingRef.current) return;
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (restoreFrameRef.current != null) {
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    restoringAnchorRef.current = false;
    stickToEndRef.current = false;
    awayRef.current = true;
    setAway(true);
    anchorRef.current = captureReadingAnchor(element);
    queueAnchorCapture();
  }, [markReadingIntent, queueAnchorCapture]);

  const markTowardEndIntent = useCallback(() => {
    markReadingIntent();
    towardEndIntentUntilRef.current = performance.now() + 1_000;
  }, [markReadingIntent]);

  const updateEdge = useCallback(() => {
    const element = viewportRef.current;
    if (!element || restoringAnchorRef.current) return;
    const gap = distanceFromEnd(element);
    const nextTailOffscreen = logicalTailIsOffscreen();
    setTailOffscreen((current) => (current === nextTailOffscreen ? current : nextTailOffscreen));
    const height = element.clientHeight;
    const previousOffset = lastScrollOffsetRef.current;
    const readingIntent =
      pointerReadingRef.current || performance.now() <= readingIntentUntilRef.current;
    const movedUp = element.scrollTop < previousOffset && pointerReadingRef.current;
    const movedTowardEnd =
      element.scrollTop > previousOffset &&
      (pointerReadingRef.current || performance.now() <= towardEndIntentUntilRef.current);
    const resizedWhilePinned =
      lastViewportHeightRef.current > 0 &&
      height !== lastViewportHeightRef.current &&
      !awayRef.current &&
      lastEndGapRef.current <= END_THRESHOLD &&
      stickToEndRef.current &&
      followRef.current;
    if (resizedWhilePinned) {
      lastViewportHeightRef.current = height;
      resizePinRef.current = true;
      stickToEndRef.current = true;
      awayRef.current = false;
      setAway(false);
      queueScrollToEnd(virtualizer);
      return;
    }
    lastViewportHeightRef.current = element.clientHeight;
    lastEndGapRef.current = gap;
    lastScrollOffsetRef.current = element.scrollTop;
    if (resizePinRef.current) return;
    const nextAway =
      element.scrollHeight > element.clientHeight &&
      (gap > END_THRESHOLD ||
        movedUp ||
        (awayRef.current && !stickToEndRef.current && !(movedTowardEnd && gap <= END_THRESHOLD)));
    if (movedUp) stickToEndRef.current = false;
    if (nextAway && stickToEndRef.current && followRef.current && !readingIntent) {
      awayRef.current = false;
      setAway(false);
      queueScrollToEnd(virtualizer);
      return;
    }
    if (!followRef.current && !restoringAnchorRef.current) {
      frozenOffsetRef.current = element.scrollTop;
    }
    awayRef.current = nextAway;
    setAway((current) => (current === nextAway ? current : nextAway));
    if (nextAway) {
      stickToEndRef.current = false;
      if (!restoringAnchorRef.current) {
        anchorRef.current = captureReadingAnchor(element);
        queueAnchorCapture();
      }
    } else {
      setUnread(0);
      stickToEndRef.current = followRef.current;
      readingIntentUntilRef.current = 0;
      towardEndIntentUntilRef.current = 0;
      anchorRef.current = null;
    }
    if (!nextTailOffscreen) {
      if (unreadFrameRef.current == null) pendingCountedIdsRef.current.clear();
      setUnread(0);
    }
  }, [logicalTailIsOffscreen, queueAnchorCapture, queueScrollToEnd, virtualizer]);
  updateEdgeRef.current = updateEdge;

  const handleScroll = useCallback((_event: UIEvent<HTMLDivElement>) => updateEdge(), [updateEdge]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    lastViewportHeightRef.current = element.clientHeight;
    lastEndGapRef.current = distanceFromEnd(element);
    const observer = new ResizeObserver(() => {
      const height = element.clientHeight;
      if (height === lastViewportHeightRef.current) return;
      if (element.scrollHeight <= height) {
        updateEdge();
        return;
      }
      const wasPinned =
        !awayRef.current &&
        lastEndGapRef.current <= END_THRESHOLD &&
        stickToEndRef.current &&
        followRef.current;
      lastViewportHeightRef.current = height;
      if (wasPinned || initializingRef.current) {
        resizePinRef.current = true;
        stickToEndRef.current = true;
        awayRef.current = false;
        setAway(false);
        queueScrollToEnd(virtualizer);
      } else {
        lastEndGapRef.current = distanceFromEnd(element);
        if (awayRef.current) anchorRef.current = captureReadingAnchor(element);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [queueScrollToEnd, updateEdge, virtualizer]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const updatePadding = () => {
      const style = getComputedStyle(element);
      const start = Number.parseFloat(style.paddingTop);
      const end = Number.parseFloat(style.paddingBottom);
      const gap = Number.parseFloat(style.getPropertyValue("--transcript-row-gap"));
      if (Number.isFinite(start))
        setStartPadding((current) => (current === start ? current : start));
      if (Number.isFinite(end)) setEndPadding((current) => (current === end ? current : end));
      if (Number.isFinite(gap)) setRowGap((current) => (current === gap ? current : gap));
    };
    updatePadding();
    const observer = new ResizeObserver(updatePadding);
    observer.observe(viewportRef.current ?? element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (rows.length === 0) {
      awayRef.current = false;
      setAway(false);
      setTailOffscreen(false);
      setUnread(0);
      initializingRef.current = false;
      stickToEndRef.current = follow;
      setInitializing(false);
      return;
    }

    if (initializingRef.current) {
      virtualizer.scrollToIndex(rows.length - 1, {
        align: "end",
        behavior: "auto",
      });
      queueScrollToEnd(virtualizer);
      return;
    }

    const anchor = anchorRef.current;
    if (restoringAnchorRef.current && anchor) {
      if (restoreFrameRef.current != null) return;
      const index = rowKeys.indexOf(anchor.key);
      const seekAnchor = () => {
        const offset = index < 0 ? undefined : virtualizer.getOffsetForIndex(index, "start");
        if (!offset) return;
        virtualizer.scrollToOffset(offset[0] - anchor.offset, {
          align: "start",
          behavior: "auto",
        });
      };
      seekAnchor();
      let attempts = 0;
      let stableFrames = 0;
      let mountedAnchorFound = false;
      const settleAnchor = () => {
        attempts++;
        const element = viewportRef.current;
        if (!element) return;
        const before = element.scrollTop;
        const found = restoreReadingAnchor(element, anchor);
        mountedAnchorFound ||= found;
        const correction = Math.abs(element.scrollTop - before);
        // A prepend changes every following index. If the first estimated seek
        // lands outside the mounted range, keep seeking the saved key while the
        // virtualizer reconciles its new measurements; a DOM-only retry can
        // never recover a row that was not mounted.
        if (!found && !mountedAnchorFound) seekAnchor();
        stableFrames = found && correction < 1 ? stableFrames + 1 : 0;
        if (attempts < 12 && stableFrames < 2) {
          restoreFrameRef.current = requestAnimationFrame(settleAnchor);
          return;
        }
        restoreFrameRef.current = null;
        anchorRef.current = captureReadingAnchor(element);
        restoringAnchorRef.current = false;
        updateEdge();
      };
      restoreFrameRef.current = requestAnimationFrame(settleAnchor);
    } else if (!follow && rowsChanged) {
      const offset = frozenOffsetRef.current ?? lastScrollOffsetRef.current;
      restoringAnchorRef.current = true;
      let attempts = 0;
      let stableFrames = 0;
      const settleOffset = () => {
        attempts++;
        const element = viewportRef.current;
        if (!element) return;
        const correction = Math.abs(element.scrollTop - offset);
        element.scrollTop = offset;
        stableFrames = correction < 1 ? stableFrames + 1 : 0;
        if (attempts < 12 && stableFrames < 2) {
          restoreFrameRef.current = requestAnimationFrame(settleOffset);
          return;
        }
        restoreFrameRef.current = null;
        restoringAnchorRef.current = false;
        updateEdge();
      };
      restoreFrameRef.current = requestAnimationFrame(settleOffset);
    } else if (stickToEndRef.current && follow) {
      virtualizer.scrollToIndex(rows.length - 1, {
        align: "end",
        behavior: "auto",
      });
    }

    requestAnimationFrame(updateEdge);
  }, [
    follow,
    keysChanged,
    queueScrollToEnd,
    rowKeys,
    rowsChanged,
    rows.length,
    updateEdge,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    priorRowKeysRef.current = rowKeys;
    priorRowsRef.current = rows;
  }, [rowKeys, rows]);

  useLayoutEffect(() => {
    const previous = priorIdsRef.current;
    const previousTail = previous.ordered.at(-1);
    const previousTailIndex = previousTail ? messageIds.indexOf(previousTail) : -1;
    const counted = new Set(countedMessageIds);
    // Earlier native history can prepend IDs; only additions after the prior
    // logical tail are new transcript messages.
    if (previousTailIndex >= 0 && (awayRef.current || !follow)) {
      for (let index = previousTailIndex + 1; index < messageIds.length; index++) {
        const id = messageIds[index];
        if (id && counted.has(id) && !previous.set.has(id)) pendingCountedIdsRef.current.add(id);
      }
      if (!follow) {
        awayRef.current = true;
        setAway(true);
      }
    }
    priorIdsRef.current = { ordered: messageIds, set: new Set(messageIds) };
    queueUnreadMeasurement();
    requestAnimationFrame(updateEdge);
  }, [countedMessageIds, follow, messageIds, queueUnreadMeasurement, updateEdge]);

  useLayoutEffect(
    () => () => {
      if (scrollFrameRef.current != null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      if (anchorFrameRef.current != null) {
        cancelAnimationFrame(anchorFrameRef.current);
        anchorFrameRef.current = null;
      }
      if (restoreFrameRef.current != null) {
        cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
      if (unreadFrameRef.current != null) {
        cancelAnimationFrame(unreadFrameRef.current);
        unreadFrameRef.current = null;
      }
      if (edgeFrameRef.current != null) {
        cancelAnimationFrame(edgeFrameRef.current);
        edgeFrameRef.current = null;
      }
    },
    [],
  );

  const jumpToLatest = useCallback(() => {
    stickToEndRef.current = true;
    readingIntentUntilRef.current = 0;
    towardEndIntentUntilRef.current = 0;
    awayRef.current = false;
    setAway(false);
    setTailOffscreen(false);
    setUnread(0);
    pendingCountedIdsRef.current.clear();
    if (rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, {
        align: "end",
        behavior: "auto",
      });
    }
    requestAnimationFrame(() => {
      stickToEndRef.current = followRef.current;
      updateEdge();
    });
  }, [rows.length, updateEdge, virtualizer]);

  const countLabel = `${unread} new ${unread === 1 ? "message" : "messages"}`;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      data-slot="message-scroller"
      style={{
        position: "relative",
        display: "flex",
        flex: "1 1 auto",
        width: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        ref={viewportRef}
        id={viewportId}
        data-slot="message-scroller-viewport"
        role="region"
        tabIndex={0}
        aria-label={label}
        onFocusCapture={(event) => {
          if (!(event.target instanceof Element)) return;
          // Portaled dialogs bubble through their source row in React. Retain
          // that row while inspecting, so the dialog and native opener survive.
          if (event.target.closest('[role="dialog"]')) return;
          setFocusedRowKey(
            event.target.closest<HTMLElement>("[data-windowed-row-key]")?.dataset.windowedRowKey ??
              null,
          );
        }}
        onBlurCapture={(event) => {
          const next = event.relatedTarget;
          if (
            next instanceof Element &&
            (event.currentTarget.contains(next) || next.closest('[role="dialog"]'))
          )
            return;
          setFocusedRowKey(null);
        }}
        onScroll={handleScroll}
        onWheel={(event) => {
          if (event.ctrlKey) return;
          if (event.deltaY < 0) disengageEndFollow();
          else if (event.deltaY > 0 && awayRef.current) markTowardEndIntent();
        }}
        onTouchStart={(event) => {
          touchYRef.current =
            event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
          if (touchYRef.current == null) return;
          markReadingIntent();
        }}
        onTouchMove={(event) => {
          if (event.touches.length !== 1) {
            touchYRef.current = null;
            return;
          }
          const nextY = event.touches[0]?.clientY ?? null;
          if (nextY != null && touchYRef.current != null && nextY > touchYRef.current) {
            disengageEndFollow();
          } else if (nextY != null && touchYRef.current != null && nextY < touchYRef.current) {
            markTowardEndIntent();
          } else {
            markReadingIntent();
          }
          touchYRef.current = nextY;
        }}
        onTouchEnd={() => {
          touchYRef.current = null;
        }}
        onTouchCancel={() => {
          touchYRef.current = null;
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            pointerReadingRef.current = true;
            markReadingIntent();
          }
        }}
        onPointerUp={() => {
          if (pointerReadingRef.current) {
            pointerReadingRef.current = false;
            markReadingIntent();
          }
        }}
        onPointerCancel={() => {
          pointerReadingRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab") markReadingIntent();
          else if (
            event.target === event.currentTarget &&
            (event.key === "ArrowUp" ||
              event.key === "PageUp" ||
              event.key === "Home" ||
              (event.key === " " && event.shiftKey))
          )
            disengageEndFollow();
          else if (
            event.target === event.currentTarget &&
            (event.key === "ArrowDown" ||
              event.key === "PageDown" ||
              event.key === "End" ||
              event.key === " ")
          )
            markTowardEndIntent();
        }}
        style={{
          width: "100%",
          minWidth: 0,
          minHeight: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
          scrollbarGutter: "stable",
          visibility: initializing ? "hidden" : undefined,
        }}
      >
        <div
          ref={setContentElement}
          data-slot="message-scroller-content"
          role="log"
          className="chat-transcript"
          style={{ position: "relative", minHeight: "100%" }}
        >
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                // Refresh the settled disclosure without discarding other row sizes.
                // measure() clears cached heights without remeasuring stable refs.
                onTransitionEnd={(event) => {
                  if (event.target !== event.currentTarget)
                    virtualizer.resizeItem(virtualRow.index, event.currentTarget.offsetHeight);
                }}
                onAnimationEnd={(event) => {
                  if (event.target !== event.currentTarget)
                    virtualizer.resizeItem(virtualRow.index, event.currentTarget.offsetHeight);
                }}
                data-index={virtualRow.index}
                data-windowed-row-key={row.key}
                data-slot={row.kind === "block" ? "message-scroller-item" : undefined}
                data-message-id={row.kind === "block" ? row.block.id : undefined}
                style={{
                  position: "absolute",
                  top: 0,
                  left: "var(--transcript-inline-padding, 32px)",
                  width: "calc(100% - 2 * var(--transcript-inline-padding, 32px))",
                  minWidth: 0,
                  boxSizing: "border-box",
                }}
              >
                {row.kind === "block" ? renderBlock(row.block) : row.content}
              </div>
            );
          })}
        </div>
      </div>
      {showJumpToLatest && away && tailOffscreen ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="jump-latest"
          aria-label={unread > 0 ? `${countLabel}. Jump to latest` : "Jump to latest"}
          onClick={jumpToLatest}
          style={{
            position: "absolute",
            left: "50%",
            bottom: 16,
            zIndex: 1,
            transform: "translateX(-50%)",
          }}
        >
          <ArrowDownIcon data-icon="inline-start" aria-hidden="true" />
          <span aria-live="polite" aria-atomic="true">
            {unread > 0 ? countLabel : "Jump to latest"}
          </span>
        </Button>
      ) : null}
    </div>
  );
}
