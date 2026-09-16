import { cn } from "cn";
import { ArrowDownIcon } from "lucide-react";
import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityGroup } from "../components/chat/activity-group";
import { ChatMessage } from "../components/chat/chat-message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "../components/ui/message-scroller";
import { TooltipProvider } from "../components/ui/tooltip";
import { isSystemEventMessage } from "../lib/system-events";
import { groupTranscript, type TranscriptEntry } from "../lib/transcript";
import type { Message } from "../types/message";
import { DisclosureStateProvider } from "./disclosure-state";
import type { TranscriptDetail } from "./types";
import { WindowedTranscript } from "./windowed-transcript";

/** Keep subscription updates out of the transcript's message rendering. */
function TranscriptFollow({
  messages,
  follow,
  showJumpToLatest,
}: Pick<Required<TranscriptProps>, "messages" | "follow" | "showJumpToLatest">) {
  const { end: away } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();
  const orderedIds = useMemo(() => messages.map((message) => message.id), [messages]);
  const [storedIds, setStoredIds] = useState(() => ({
    ordered: orderedIds,
    set: new Set(orderedIds) as ReadonlySet<string>,
  }));
  let ids = storedIds;
  if (
    orderedIds.length !== storedIds.ordered.length ||
    orderedIds.some((id, index) => id !== storedIds.ordered[index])
  ) {
    ids = { ordered: orderedIds, set: new Set(orderedIds) };
    setStoredIds(ids);
  }
  const [previous, setPrevious] = useState({ ids, away, follow, unread: 0 });
  const wasFollowing = useRef(follow);
  let unread = previous.unread;
  if (previous.ids !== ids || previous.away !== away || previous.follow !== follow) {
    if (!away && (follow || previous.away)) {
      unread = 0;
    } else if (previous.ids !== ids) {
      for (const id of ids.set) if (!previous.ids.set.has(id)) unread++;
    }
    setPrevious({ ids, away, follow, unread });
  }

  useLayoutEffect(() => {
    // Use the edge state from before this commit grows the DOM. Wheel/key
    // intent can release the primitive without moving an already-ended viewport;
    // explicitly resume it before its content observer measures the new end.
    // Calling the public action once when disabling follow at the end also
    // releases its internal follow mode, which otherwise masks the jump button.
    if (!away && (follow || wasFollowing.current)) {
      scrollToEnd({ behavior: "auto" });
    }
    wasFollowing.current = follow;
  }, [messages, away, follow, scrollToEnd]);

  const countLabel = `${unread} new ${unread === 1 ? "message" : "messages"}`;
  return showJumpToLatest && away ? (
    <MessageScrollerButton
      size="sm"
      className="jump-latest"
      behavior="auto"
      aria-label={unread > 0 ? `${countLabel}. Jump to latest` : "Jump to latest"}
    >
      <ArrowDownIcon data-icon="inline-start" aria-hidden="true" />
      <span aria-live="polite" aria-atomic="true">
        {unread > 0 ? countLabel : "Jump to latest"}
      </span>
    </MessageScrollerButton>
  ) : null;
}

export interface TranscriptBlockProps {
  block: TranscriptEntry;
}

const BlockContent = memo(function BlockContent({ block }: TranscriptBlockProps) {
  return block.kind === "activity" ? (
    <ActivityGroup messages={block.messages} />
  ) : (
    <ChatMessage message={block.message} />
  );
});

const TranscriptItem = memo(function TranscriptItem({ block }: TranscriptBlockProps) {
  return (
    <MessageScrollerItem messageId={block.id}>
      <BlockContent block={block} />
    </MessageScrollerItem>
  );
});

function renderTranscriptBlock(block: TranscriptEntry) {
  return <BlockContent block={block} />;
}

function useVisibleMessages(messages: readonly Message[], detail: TranscriptDetail) {
  const next = useMemo(
    () =>
      detail === "full"
        ? messages
        : messages.filter(
            (message) =>
              message.role === "user" ||
              message.role === "assistant" ||
              isSystemEventMessage(message),
          ),
    [messages, detail],
  );
  const [stored, setStored] = useState(() => ({ input: next, output: next }));
  if (next === stored.input) return stored.output;
  let output = next;
  if (
    next.length === stored.output.length &&
    next.every((message, index) => message === stored.output[index])
  ) {
    output = stored.output;
  }
  setStored({ input: next, output });
  return output;
}

function useTranscriptBlocks(messages: readonly Message[]) {
  const grouped = useMemo(() => groupTranscript(messages), [messages]);
  const [stored, setStored] = useState<{
    input: readonly TranscriptEntry[];
    output: readonly TranscriptEntry[];
  }>(() => ({ input: grouped, output: grouped }));
  if (grouped === stored.input) return stored.output;
  const previous = stored.output;
  const previousById = new Map(previous.map((block) => [block.id, block]));
  const next = grouped.map((block) => {
    const prior = previousById.get(block.id);
    if (!prior || prior.kind !== block.kind) return block;
    if (block.kind === "message" && prior.kind === "message") {
      return block.message === prior.message ? prior : block;
    }
    if (block.kind === "activity" && prior.kind === "activity") {
      return block.messages.length === prior.messages.length &&
        block.messages.every((message, index) => message === prior.messages[index])
        ? prior
        : block;
    }
    return block;
  });
  if (next.length === previous.length && next.every((block, index) => block === previous[index])) {
    setStored({ input: grouped, output: previous });
    return previous;
  }
  setStored({ input: grouped, output: next });
  return next;
}

/** A single prose message or collapsed activity run, for host-owned layouts. */
export function TranscriptBlock({ block }: TranscriptBlockProps) {
  return (
    <div className="agentchats-transcript">
      <DisclosureStateProvider>
        <TooltipProvider>
          <BlockContent block={block} />
        </TooltipProvider>
      </DisclosureStateProvider>
    </div>
  );
}

export interface TranscriptProps {
  /** Changing this ID resets scroll and disclosure state. */
  transcriptId: string;
  messages: readonly Message[];
  detail?: TranscriptDetail;
  loading?: boolean;
  /** Follow the bottom until the reader scrolls away; independent of agent status. */
  follow?: boolean;
  /** Show the new-message count and jump control when away from the end. Default true. */
  showJumpToLatest?: boolean;
  /** Bound mounted rows for long transcripts while preserving reading position. */
  windowed?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  className?: string;
  viewportId?: string;
  "aria-label"?: string;
}

/** Presentation only: no fetching, storage, session navigation, or command UI. */
export function Transcript({
  transcriptId,
  messages,
  detail = "messages",
  loading = false,
  follow = true,
  showJumpToLatest = true,
  windowed = false,
  header,
  footer,
  empty,
  className,
  viewportId,
  "aria-label": label = "Human / Agent transcript",
}: TranscriptProps) {
  const visibleMessages = useVisibleMessages(messages, detail);
  const blocks = useTranscriptBlocks(visibleMessages);
  const messageIds = useMemo(() => visibleMessages.map((message) => message.id), [visibleMessages]);
  const countedMessageIds = useMemo(
    () =>
      visibleMessages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => message.id),
    [visibleMessages],
  );
  const incarnationKey = `${transcriptId}:${detail}:${loading ? "loading" : "ready"}`;
  return (
    <div className={cn("agentchats-transcript chat-pane", className)}>
      <DisclosureStateProvider key={transcriptId}>
        <TooltipProvider>
          {windowed ? (
            <WindowedTranscript
              key={incarnationKey}
              blocks={blocks}
              messageIds={messageIds}
              countedMessageIds={countedMessageIds}
              renderBlock={renderTranscriptBlock}
              follow={follow}
              showJumpToLatest={showJumpToLatest}
              header={header}
              footer={footer}
              empty={empty}
              viewportId={viewportId}
              aria-label={label}
            />
          ) : (
            <MessageScrollerProvider
              autoScroll={follow}
              scrollEdgeThreshold={64}
              defaultScrollPosition="end"
              key={incarnationKey}
            >
              <MessageScroller>
                <MessageScrollerViewport id={viewportId} tabIndex={0} aria-label={label}>
                  <MessageScrollerContent className="chat-transcript">
                    {header}
                    {blocks.length === 0 ? empty : null}
                    {blocks.map((block) => (
                      <TranscriptItem key={block.id} block={block} />
                    ))}
                    {footer}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <TranscriptFollow
                  messages={visibleMessages}
                  follow={follow}
                  showJumpToLatest={showJumpToLatest}
                />
              </MessageScroller>
            </MessageScrollerProvider>
          )}
        </TooltipProvider>
      </DisclosureStateProvider>
    </div>
  );
}
