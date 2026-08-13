import { homedir } from "node:os";
import { createFleetFooter } from "../tui/footer.ts";
import type { ChatsConnection } from "./client.ts";
import {
  type ChatsModel,
  type ChatsStream,
  type RawStreamEvent,
  VOICE_STREAM_ID,
  type VoiceSession,
} from "./model.ts";
import type { TranscriptSource } from "./transcript-source.ts";
import {
  TranscriptHarnessView,
  type TranscriptViewState,
  transcriptRows,
} from "./transcript-ui.ts";

interface RendererFactoryResult {
  renderer: Awaited<ReturnType<typeof import("@opentui/core")["createCliRenderer"]>>;
}

const TONES = {
  canvas: "#090c0e",
  field: "#0d1215",
  panel: "#131a1e",
  selected: "#172328",
  line: "#2a343a",
  text: "#d8e2e7",
  muted: "#7d8a91",
  faint: "#4b575e",
  accent: "#67d7c9",
  upstream: "#7fb9e8",
  downstream: "#e2b56f",
  client: "#b09ce8",
  ok: "#82cb9a",
  hot: "#e6965b",
  danger: "#ee7e89",
} as const;

export interface ChatsUiOptions {
  connection: Pick<ChatsConnection, "close">;
  model: ChatsModel;
  transcripts: TranscriptSource;
  refreshThreads(reread?: boolean): Promise<void>;
  setEventHandler(handler: (event: RawStreamEvent) => void): void;
  onClosed(): void;
  createRenderer?(): Promise<RendererFactoryResult["renderer"]>;
}

function compact(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function homeRelativePath(path: string, home = homedir()): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function eventLabel(event: RawStreamEvent): string {
  if (event.kind === "voice") {
    const observation = event.observation;
    if (observation.kind === "event") {
      const type = observation.payload["type"];
      return typeof type === "string" ? type : "voice event";
    }
    if (observation.kind === "lifecycle") {
      return `${observation.state}${observation.reason ? ` · ${observation.reason}` : ""}`;
    }
    return `gap ${observation.fromSequence}–${observation.toSequence} · ${observation.dropped} dropped`;
  }
  const method = event.payload["method"];
  if (typeof method === "string") return method;
  const id = event.payload["id"];
  return `response${id === undefined ? "" : ` #${String(id)}`}`;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export async function runChatsUi(options: ChatsUiOptions): Promise<void> {
  const core = await import("@opentui/core");
  const renderer = options.createRenderer
    ? await options.createRenderer()
    : await core.createCliRenderer({
        exitOnCtrlC: false,
        screenMode: "alternate-screen",
        targetFps: 30,
        autoFocus: false,
        exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
        backgroundColor: TONES.canvas,
      });
  const syntaxStyle = core.SyntaxStyle.fromStyles({
    string: { fg: TONES.downstream },
    number: { fg: TONES.upstream },
    boolean: { fg: TONES.client, bold: true },
    constant: { fg: TONES.client },
    property: { fg: TONES.accent },
    punctuation: { fg: TONES.muted },
    "punctuation.bracket": { fg: TONES.muted },
    "punctuation.delimiter": { fg: TONES.faint },
  });

  const root = new core.BoxRenderable(renderer, {
    id: "chats-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: TONES.canvas,
  });
  renderer.root.add(root);

  // Signal Room headers deliberately reserve one empty row above the title.
  const header = new core.BoxRenderable(renderer, {
    id: "chats-header",
    width: "100%",
    height: 3,
    paddingTop: 1,
    paddingLeft: 2,
    paddingRight: 2,
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: TONES.field,
    border: ["bottom"],
    borderStyle: "single",
    borderColor: TONES.line,
  });
  const headerTitle = new core.TextRenderable(renderer, {
    id: "chats-title",
    content: "▎ AGENTVOICE / CHATS",
    fg: TONES.accent,
    flexShrink: 0,
    wrapMode: "none",
  });
  const headerStatus = new core.TextRenderable(renderer, {
    id: "chats-status",
    content: "",
    fg: TONES.muted,
    maxWidth: "48%",
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  });
  header.add(headerTitle);
  header.add(headerStatus);
  root.add(header);

  const main = new core.BoxRenderable(renderer, {
    id: "chats-main",
    width: "100%",
    flexGrow: 1,
    backgroundColor: TONES.canvas,
  });
  root.add(main);

  const listScroll = new core.ScrollBoxRenderable(renderer, {
    id: "thread-list",
    width: "100%",
    height: "100%",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: TONES.canvas,
    viewportCulling: true,
  });
  main.add(listScroll);

  const detail = new core.BoxRenderable(renderer, {
    id: "thread-detail",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: TONES.canvas,
    visible: false,
  });
  const detailHeader = new core.BoxRenderable(renderer, {
    id: "detail-header",
    width: "100%",
    height: 6,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: TONES.field,
    border: ["bottom"],
    borderColor: TONES.line,
    flexDirection: "column",
  });
  const detailHeadline = new core.BoxRenderable(renderer, {
    id: "detail-headline",
    width: "100%",
    height: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: TONES.field,
  });
  const backButton = new core.BoxRenderable(renderer, {
    id: "detail-back",
    height: 1,
    paddingRight: 3,
    backgroundColor: TONES.field,
    onMouseUp: () => closeDetail(),
  });
  backButton.add(
    new core.TextRenderable(renderer, {
      id: "detail-back-label",
      content: new core.StyledText([core.bold(core.fg(TONES.accent)("← CHATS"))]),
    }),
  );
  const detailTitle = new core.TextRenderable(renderer, {
    id: "detail-title",
    content: "",
    fg: TONES.text,
    flexGrow: 1,
    wrapMode: "none",
  });
  const detailState = new core.TextRenderable(renderer, {
    id: "detail-state",
    content: "",
    fg: TONES.muted,
  });
  const detailFacts = new core.TextRenderable(renderer, {
    id: "detail-facts",
    content: "",
    fg: TONES.muted,
    wrapMode: "word",
  });
  detailHeadline.add(backButton);
  detailHeadline.add(detailTitle);
  detailHeadline.add(detailState);
  detailHeader.add(detailHeadline);
  detailHeader.add(detailFacts);
  detail.add(detailHeader);

  const eventScroll = new core.ScrollBoxRenderable(renderer, {
    id: "event-stream",
    width: "100%",
    flexGrow: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: TONES.canvas,
    viewportCulling: true,
    stickyScroll: true,
    stickyStart: "top",
  });
  detail.add(eventScroll);
  const harnessScroll = new core.ScrollBoxRenderable(renderer, {
    id: "harness-stream",
    width: "100%",
    flexGrow: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: TONES.canvas,
    viewportCulling: true,
    stickyScroll: true,
    stickyStart: "top",
    visible: false,
  });
  detail.add(harnessScroll);
  main.add(detail);

  const footer = createFleetFooter(core, renderer, "chats-footer", {
    field: TONES.field,
    line: TONES.line,
    accent: TONES.accent,
    muted: TONES.muted,
  });
  root.add(footer.root);

  let view: "list" | "detail" = "list";
  let streamIndex = 0;
  let selectedStreamId: string | null = null;
  let eventIndex = -1;
  let selectedEventSequence: number | null = null;
  let followTail = true;
  let detailMode: "harness" | "frames" = "harness";
  let transcriptLoading = false;
  let transcriptError: string | null = null;
  let transcriptLoadEpoch = 0;
  let selectedTranscriptKey: string | null = null;
  const expandedTranscriptKeys = new Set<string>();
  const rawTranscriptKeys = new Set<string>();
  let refreshing = false;
  let connectionError: string | null = null;
  const expanded = new Set<number>();
  const eventBoxes = new Map<
    number,
    {
      box: InstanceType<typeof core.BoxRenderable>;
      code: InstanceType<typeof core.CodeRenderable>;
    }
  >();
  let emptyEvents: InstanceType<typeof core.TextRenderable> | null = null;
  let droppedEvents: InstanceType<typeof core.TextRenderable> | null = null;
  const harnessView = new TranscriptHarnessView(
    core,
    renderer,
    harnessScroll,
    syntaxStyle,
    {
      canvas: TONES.canvas,
      panel: TONES.panel,
      selected: TONES.selected,
      line: TONES.line,
      text: TONES.text,
      muted: TONES.muted,
      faint: TONES.faint,
      accent: TONES.accent,
      local: TONES.downstream,
      remote: TONES.upstream,
      ok: TONES.ok,
      hot: TONES.hot,
      danger: TONES.danger,
    },
    (key) => {
      const alreadySelected = selectedTranscriptKey === key;
      followTail = false;
      selectedTranscriptKey = key;
      if (alreadySelected) toggleTranscriptExpanded();
      else rebuildHarness();
    },
  );

  function clear(container: InstanceType<typeof core.ScrollBoxRenderable>): void {
    for (const child of container.getChildren()) {
      container.remove(child);
      child.destroyRecursively();
    }
  }

  function selectedStream(): ChatsStream | null {
    return selectedStreamId
      ? (options.model.sortedStreams.find((stream) => stream.id === selectedStreamId) ?? null)
      : null;
  }

  function updateChrome(): void {
    const threads = options.model.sortedThreads;
    const width = renderer.width || process.stdout.columns || 100;
    if (view === "list") {
      headerTitle.content = "▎ AGENTVOICE / CHATS";
      headerStatus.content = connectionError
        ? `DISCONNECTED / ${compact(connectionError, 42)}`
        : `${threads.length} LOADED`;
      headerStatus.fg = connectionError ? TONES.danger : TONES.muted;
      footer.update({
        width,
        mode: "LIVE / 2s",
        actions: [
          {
            id: "previous",
            key: "↑",
            label: "previous",
            shortLabel: "prev",
            onPress: () => updateThreadSelection(-1),
          },
          { id: "next", key: "↓", label: "next", onPress: () => updateThreadSelection(1) },
          { id: "open", key: "ENTER", label: "open", onPress: () => openDetail() },
          { id: "refresh", key: "R", label: "refresh", onPress: () => void refresh(true) },
          { id: "quit", key: "Q", label: "quit", onPress: () => shutdown() },
        ],
      });
    } else {
      const stream = selectedStream();
      const events = stream ? options.model.eventsFor(stream) : [];
      const rows =
        stream?.kind === "thread" ? transcriptRows(options.transcripts.get(stream.id)) : [];
      const harness = stream?.kind === "thread" && detailMode === "harness";
      headerTitle.content = "▎ AGENTVOICE / CHATS";
      headerStatus.content = transcriptError
        ? `FAILED / ${compact(transcriptError, 42)}`
        : transcriptLoading && harness
          ? "LOADING HISTORY"
          : `${harness ? rows.length : events.length} ${harness ? "ITEMS" : "EVENTS"}${
              followTail && width >= 56 ? "  FOLLOW" : ""
            }`;
      headerStatus.fg = transcriptError ? TONES.danger : TONES.muted;
      footer.update({
        width,
        mode: `${harness ? "HARNESS" : "FRAMES"} / ${followTail ? "FOLLOW" : "HOLD"}`,
        actions: [
          { id: "back", key: "ESC", label: "chats", onPress: () => closeDetail() },
          {
            id: "previous",
            key: "↑",
            label: "previous",
            shortLabel: "prev",
            onPress: () => selectPreviousDetailItem(),
          },
          { id: "next", key: "↓", label: "next", onPress: () => selectNextDetailItem() },
          { id: "expand", key: "ENTER", label: "expand", onPress: () => toggleDetailExpanded() },
          ...(stream?.kind === "thread"
            ? [
                {
                  id: "view",
                  key: "V",
                  label: harness ? "frames" : "harness",
                  onPress: () => toggleDetailMode(),
                },
                ...(harness
                  ? [
                      {
                        id: "raw",
                        key: "R",
                        label: "raw",
                        onPress: () => toggleTranscriptRaw(),
                      },
                    ]
                  : []),
              ]
            : []),
          {
            id: "page-up",
            key: "PG↑",
            label: "scroll up",
            shortLabel: "up",
            onPress: () => scrollEvents(-12),
          },
          {
            id: "page-down",
            key: "PG↓",
            label: "scroll down",
            shortLabel: "down",
            onPress: () => scrollEvents(12),
          },
          { id: "follow", key: "F", label: "follow", onPress: () => followDetail() },
          { id: "quit", key: "Q", label: "quit", onPress: () => shutdown() },
        ],
      });
    }
  }

  function streamCardId(stream: ChatsStream): string {
    return stream.kind === "voice" ? "voice-stream-card" : `thread-card-${stream.id}`;
  }

  function cardStateTone(status: string): string {
    if (/failed|error|declined/i.test(status)) return TONES.danger;
    if (/active|running|progress|waiting/i.test(status)) return TONES.hot;
    return TONES.muted;
  }

  function addStreamCardContent(
    box: InstanceType<typeof core.BoxRenderable>,
    stream: ChatsStream,
    selected: boolean,
  ): void {
    const first = new core.BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: selected ? TONES.selected : TONES.canvas,
    });
    const title = stream.kind === "voice" ? stream.name : stream.thread.name;
    const status =
      stream.kind === "voice"
        ? (options.model.voiceSessionList.at(-1)?.state.toUpperCase() ?? "WAITING")
        : stream.thread.status.toUpperCase();
    first.add(
      new core.TextRenderable(renderer, {
        id: `${streamCardId(stream)}-name`,
        content: compact(title, Math.max(14, (renderer.width || 100) - 30)),
        fg: TONES.text,
        attributes: selected ? 1 : 0,
        flexGrow: 1,
        flexShrink: 1,
        wrapMode: "none",
      }),
    );
    first.add(
      new core.TextRenderable(renderer, {
        id: `${streamCardId(stream)}-state`,
        content: status,
        fg: stream.kind === "voice" ? TONES.upstream : cardStateTone(status),
        flexShrink: 0,
        wrapMode: "none",
      }),
    );
    box.add(first);

    const metadata =
      stream.kind === "voice"
        ? `${options.model.voiceSessionList.length} sessions    raw live events    audio excluded`
        : [
            stream.thread.role.toUpperCase(),
            homeRelativePath(stream.thread.cwd),
            stream.thread.modelProvider,
          ]
            .filter(Boolean)
            .join("    ");
    box.add(
      new core.TextRenderable(renderer, {
        id: `${streamCardId(stream)}-metadata`,
        content: compact(metadata, Math.max(14, (renderer.width || 100) - 8)),
        fg: TONES.muted,
        wrapMode: "none",
      }),
    );
  }

  function rebuildThreadList(): void {
    const previous = selectedStreamId;
    const streams = options.model.sortedStreams;
    if (previous) {
      const nextIndex = streams.findIndex((stream) => stream.id === previous);
      if (nextIndex >= 0) streamIndex = nextIndex;
    }
    streamIndex = Math.max(0, Math.min(streamIndex, Math.max(0, streams.length - 1)));
    selectedStreamId = streams[streamIndex]?.id ?? null;
    clear(listScroll);
    streams.forEach((stream, index) => {
      const selected = index === streamIndex;
      const box = new core.BoxRenderable(renderer, {
        id: streamCardId(stream),
        width: "100%",
        height: 2,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "column",
        backgroundColor: selected ? TONES.selected : TONES.canvas,
        border: ["left"],
        borderStyle: "heavy",
        borderColor: selected ? TONES.accent : TONES.faint,
        onMouseUp: () => {
          streamIndex = index;
          selectedStreamId = stream.id;
          openDetail();
        },
      });
      addStreamCardContent(box, stream, selected);
      listScroll.add(box);
    });
    updateChrome();
    renderer.requestRender();
  }

  function eventValue(event: RawStreamEvent): Record<string, unknown> {
    if (event.kind === "thread") return event.payload;
    const observation = event.observation;
    if (observation.kind === "event") return observation.payload;
    if (observation.kind === "lifecycle") {
      return {
        state: observation.state,
        ...(observation.reason ? { reason: observation.reason } : {}),
      };
    }
    return {
      fromSequence: observation.fromSequence,
      toSequence: observation.toSequence,
      dropped: observation.dropped,
    };
  }

  function eventCode(event: RawStreamEvent): string {
    const value = eventValue(event);
    if (expanded.has(event.sequence)) return JSON.stringify(value, null, 2);
    return truncate(JSON.stringify(value), 260);
  }

  function eventTone(event: RawStreamEvent): string {
    if (event.kind === "voice") {
      if (event.observation.kind === "gap") return TONES.danger;
      if (event.observation.kind === "lifecycle") {
        return event.observation.state === "ended" ? TONES.danger : TONES.accent;
      }
      return TONES.upstream;
    }
    if (event.owner === "client") return TONES.client;
    return event.direction === "fromAppServer" ? TONES.upstream : TONES.downstream;
  }

  function createEventWidget(event: RawStreamEvent): void {
    const eventId = `${event.kind}-event-${event.sequence}`;
    const selected = event.sequence === selectedEventSequence;
    const label =
      event.kind === "voice"
        ? `← voice · ${eventLabel(event)} · ${timeLabel(event.observedAt)}`
        : `${event.direction === "fromAppServer" ? "←" : "→"} ${event.owner} · ${eventLabel(event)} · ${timeLabel(event.receivedAt)}`;
    const box = new core.BoxRenderable(renderer, {
      id: eventId,
      width: "100%",
      marginBottom: 1,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 1,
      flexDirection: "column",
      backgroundColor: selected ? TONES.selected : TONES.panel,
      border: ["left"],
      borderStyle: selected ? "heavy" : "single",
      borderColor: selected ? TONES.accent : eventTone(event),
      onMouseUp: () => {
        const stream = selectedStream();
        const events = stream ? options.model.eventsFor(stream) : [];
        const liveIndex = events.findIndex((candidate) => candidate.sequence === event.sequence);
        if (liveIndex < 0) return;
        const wasSelected = selectedEventSequence === event.sequence;
        followTail = false;
        if (wasSelected) toggleExpanded();
        else selectEventIndex(liveIndex);
      },
    });
    box.add(
      new core.TextRenderable(renderer, {
        content: label,
        fg: eventTone(event),
        wrapMode: "word",
      }),
    );
    const code = new core.CodeRenderable(renderer, {
      id: `${event.kind}-event-code-${event.sequence}`,
      content: eventCode(event),
      filetype: "json",
      syntaxStyle,
      width: "100%",
      wrapMode: "word",
      selectable: true,
      selectionBg: TONES.accent,
      selectionFg: TONES.canvas,
      conceal: false,
      drawUnstyledText: true,
    });
    box.add(code);
    eventScroll.add(box);
    eventBoxes.set(event.sequence, { box, code });
  }

  function createVoiceSessionHeading(session: VoiceSession): void {
    const heading = new core.BoxRenderable(renderer, {
      id: `voice-session-${session.id}`,
      width: "100%",
      marginTop: 1,
      marginBottom: 1,
      paddingLeft: 1,
      flexDirection: "column",
      backgroundColor: TONES.canvas,
    });
    heading.add(
      new core.TextRenderable(renderer, {
        content: `VOICE SESSION  ${session.id}`,
        fg: TONES.accent,
        wrapMode: "word",
      }),
    );
    heading.add(
      new core.TextRenderable(renderer, {
        content: `LIFECYCLE ${session.state.toUpperCase()}${session.reason ? ` / ${session.reason}` : ""}   THREAD ${session.threadId}`,
        fg: TONES.muted,
        wrapMode: "word",
      }),
    );
    eventScroll.add(heading);
  }

  function rebuildEvents(): void {
    clear(eventScroll);
    eventBoxes.clear();
    emptyEvents = null;
    droppedEvents = null;
    const stream = selectedStream();
    const events = stream ? options.model.eventsFor(stream) : [];
    eventIndex = events.length === 0 ? -1 : Math.min(Math.max(eventIndex, 0), events.length - 1);
    selectedEventSequence = events[eventIndex]?.sequence ?? null;
    if (events.length === 0) {
      emptyEvents = new core.TextRenderable(renderer, {
        id: "empty-events",
        content:
          stream?.kind === "voice"
            ? "Waiting for a voice-session lifecycle or raw event…"
            : "Waiting for this thread's next app-server frame…",
        fg: TONES.muted,
      });
      eventScroll.add(emptyEvents);
    } else {
      if (stream?.kind === "voice") {
        for (const session of options.model.voiceSessionList) {
          createVoiceSessionHeading(session);
          session.observations.forEach(createEventWidget);
        }
      } else {
        events.forEach(createEventWidget);
      }
    }
    const dropped = stream ? options.model.droppedEventsFor(stream) : 0;
    if (dropped > 0) {
      droppedEvents = new core.TextRenderable(renderer, {
        id: "dropped-events",
        content: `${dropped} older events were evicted from this live view`,
        fg: TONES.faint,
      });
      eventScroll.add(droppedEvents, 0);
    }
    if (followTail) eventScroll.scrollTop = Number.MAX_SAFE_INTEGER;
    updateChrome();
    renderer.requestRender();
  }

  function transcriptViewState(): TranscriptViewState {
    return {
      selectedKey: selectedTranscriptKey,
      expanded: expandedTranscriptKeys,
      raw: rawTranscriptKeys,
      width: renderer.width || process.stdout.columns || 100,
    };
  }

  function rebuildHarness(): void {
    const stream = selectedStream();
    const transcript = stream?.kind === "thread" ? options.transcripts.get(stream.id) : null;
    const rows = harnessView.sync(transcript, transcriptViewState());
    if (rows.length === 0) selectedTranscriptKey = null;
    else if (!rows.some((row) => row.key === selectedTranscriptKey)) {
      selectedTranscriptKey = rows.at(-1)?.key ?? null;
      harnessView.sync(transcript, transcriptViewState());
    }
    if (followTail && selectedTranscriptKey) {
      harnessView.scrollIntoView(selectedTranscriptKey);
    }
    updateChrome();
    renderer.requestRender();
  }

  function showDetailSurface(): void {
    const stream = selectedStream();
    const harness = stream?.kind === "thread" && detailMode === "harness";
    harnessScroll.visible = harness;
    eventScroll.visible = !harness;
    if (harness) rebuildHarness();
    else rebuildEvents();
  }

  async function hydrateSelectedTranscript(force = false): Promise<void> {
    const stream = selectedStream();
    if (stream?.kind !== "thread") return;
    const epoch = ++transcriptLoadEpoch;
    transcriptLoading = true;
    transcriptError = null;
    updateChrome();
    try {
      await options.transcripts.hydrate(stream.id, force);
      if (
        epoch === transcriptLoadEpoch &&
        view === "detail" &&
        selectedStreamId === stream.id &&
        detailMode === "harness"
      ) {
        rebuildHarness();
      }
    } catch (error) {
      if (epoch === transcriptLoadEpoch) {
        transcriptError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (epoch === transcriptLoadEpoch) {
        transcriptLoading = false;
        updateChrome();
        renderer.requestRender();
      }
    }
  }

  function updateDetailHeader(): void {
    const stream = selectedStream();
    if (!stream) return;
    const width = renderer.width || process.stdout.columns || 100;
    if (stream.kind === "voice") {
      const narrow = width < 64;
      detailHeader.height = narrow ? 8 : 6;
      detailTitle.content = stream.name;
      detailState.content = "LIVE";
      detailFacts.content = new core.StyledText(
        narrow
          ? [
              core.fg(TONES.faint)("RETENTION  "),
              core.fg(TONES.text)("latest 8 sessions\n"),
              core.fg(TONES.faint)("EVENTS     "),
              core.fg(TONES.text)("300 / session\n"),
              core.fg(TONES.faint)("PAYLOAD    "),
              core.fg(TONES.text)("parsed raw events\n"),
              core.fg(TONES.faint)("AUDIO      "),
              core.fg(TONES.text)("excluded; no replay"),
            ]
          : [
              core.fg(TONES.faint)("RETENTION  "),
              core.fg(TONES.text)("latest 8 sessions"),
              core.fg(TONES.faint)("    EVENTS     "),
              core.fg(TONES.text)("300 / session"),
              core.fg(TONES.text)("\n"),
              core.fg(TONES.faint)("PAYLOAD    "),
              core.fg(TONES.text)("parsed raw events (audio excluded; no replay)"),
            ],
      );
      return;
    }
    const thread = stream.thread;
    const optional = [
      ...(thread.parentThreadId ? [["PARENT", shortId(thread.parentThreadId)] as const] : []),
    ];
    const narrow = width < 64;
    detailHeader.height = optional.length > 0 ? (narrow ? 8 : 7) : narrow ? 7 : 6;
    detailTitle.content = compact(thread.name, Math.max(12, width - 27));
    detailState.content = thread.status.toUpperCase();
    const chunks = [
      core.fg(TONES.faint)("ROLE       "),
      core.fg(TONES.text)(thread.role),
      core.fg(TONES.faint)(narrow ? "\nPROVIDER   " : "    PROVIDER   "),
      core.fg(TONES.text)(thread.modelProvider),
      core.fg(TONES.text)("\n"),
      core.fg(TONES.faint)("WORKSPACE  "),
      core.fg(TONES.text)(homeRelativePath(thread.cwd)),
    ];
    if (optional.length > 0) {
      chunks.push(core.fg(TONES.text)("\n"));
      optional.forEach(([label, value], index) => {
        chunks.push(core.fg(TONES.faint)(label.padEnd(11)));
        chunks.push(core.fg(TONES.text)(value));
        if (index < optional.length - 1) chunks.push(core.fg(TONES.faint)("    "));
      });
    }
    detailFacts.content = new core.StyledText(chunks);
  }

  function openDetail(): void {
    const streams = options.model.sortedStreams;
    const stream = streams[streamIndex];
    if (!stream) return;
    selectedStreamId = stream.id;
    view = "detail";
    listScroll.visible = false;
    detail.visible = true;
    followTail = true;
    const events = options.model.eventsFor(stream);
    eventIndex = events.length - 1;
    detailMode = stream.kind === "thread" ? "harness" : "frames";
    transcriptError = null;
    if (stream.kind === "thread") {
      const rows = transcriptRows(options.transcripts.get(stream.id));
      selectedTranscriptKey = rows.at(-1)?.key ?? null;
    }
    updateDetailHeader();
    showDetailSurface();
    if (stream.kind === "thread") void hydrateSelectedTranscript();
  }

  function closeDetail(): void {
    transcriptLoadEpoch += 1;
    transcriptLoading = false;
    transcriptError = null;
    view = "list";
    detail.visible = false;
    listScroll.visible = true;
    harnessScroll.visible = false;
    eventScroll.visible = false;
    rebuildThreadList();
    const stream = selectedStream();
    if (stream) listScroll.scrollChildIntoView(streamCardId(stream));
  }

  function updateThreadSelection(delta: number): void {
    const streams = options.model.sortedStreams;
    if (streams.length === 0) return;
    streamIndex = Math.max(0, Math.min(streams.length - 1, streamIndex + delta));
    selectedStreamId = streams[streamIndex]?.id ?? null;
    rebuildThreadList();
    const stream = selectedStream();
    if (stream) listScroll.scrollChildIntoView(streamCardId(stream));
  }

  function selectEventIndex(nextIndex: number): void {
    const stream = selectedStream();
    const events = stream ? options.model.eventsFor(stream) : [];
    if (events.length === 0) return;
    const previousSequence = selectedEventSequence;
    eventIndex = Math.max(0, Math.min(events.length - 1, nextIndex));
    selectedEventSequence = events[eventIndex]?.sequence ?? null;
    for (const [sequence, selected] of [
      [previousSequence, false],
      [selectedEventSequence, true],
    ] as const) {
      if (sequence === null) continue;
      const widget = eventBoxes.get(sequence);
      const event = events.find((candidate) => candidate.sequence === sequence);
      if (!widget || !event) continue;
      widget.box.backgroundColor = selected ? TONES.selected : TONES.panel;
      widget.box.borderColor = selected ? TONES.accent : eventTone(event);
      widget.box.borderStyle = selected ? "heavy" : "single";
    }
    const event = events[eventIndex];
    if (event) eventScroll.scrollChildIntoView(`${event.kind}-event-${event.sequence}`);
    updateChrome();
    renderer.requestRender();
  }

  function updateEventSelection(delta = 0): void {
    const stream = selectedStream();
    const events = stream ? options.model.eventsFor(stream) : [];
    if (events.length === 0) return;
    const currentIndex = selectedEventSequence
      ? events.findIndex((event) => event.sequence === selectedEventSequence)
      : eventIndex;
    selectEventIndex(Math.max(currentIndex, 0) + delta);
  }

  function selectPreviousEvent(): void {
    followTail = false;
    updateEventSelection(-1);
  }

  function selectNextEvent(): void {
    followTail = false;
    updateEventSelection(1);
  }

  function selectTranscriptIndex(nextIndex: number): void {
    const stream = selectedStream();
    if (stream?.kind !== "thread") return;
    const rows = transcriptRows(options.transcripts.get(stream.id));
    if (rows.length === 0) return;
    const currentIndex = Math.max(
      0,
      rows.findIndex((row) => row.key === selectedTranscriptKey),
    );
    const index = Math.max(0, Math.min(rows.length - 1, nextIndex));
    selectedTranscriptKey = rows[index]?.key ?? rows[currentIndex]?.key ?? null;
    rebuildHarness();
    if (selectedTranscriptKey) harnessView.scrollIntoView(selectedTranscriptKey);
  }

  function updateTranscriptSelection(delta: number): void {
    const stream = selectedStream();
    if (stream?.kind !== "thread") return;
    const rows = transcriptRows(options.transcripts.get(stream.id));
    const index = rows.findIndex((row) => row.key === selectedTranscriptKey);
    selectTranscriptIndex(Math.max(index, 0) + delta);
  }

  function selectPreviousDetailItem(): void {
    const stream = selectedStream();
    if (stream?.kind === "thread" && detailMode === "harness") {
      followTail = false;
      updateTranscriptSelection(-1);
    } else selectPreviousEvent();
  }

  function selectNextDetailItem(): void {
    const stream = selectedStream();
    if (stream?.kind === "thread" && detailMode === "harness") {
      followTail = false;
      updateTranscriptSelection(1);
    } else selectNextEvent();
  }

  function scrollEvents(delta: number): void {
    followTail = false;
    const stream = selectedStream();
    const scroll =
      stream?.kind === "thread" && detailMode === "harness" ? harnessScroll : eventScroll;
    scroll.scrollBy({ x: 0, y: delta });
    updateChrome();
    renderer.requestRender();
  }

  function followEvents(): void {
    followTail = true;
    updateEventSelection(Number.MAX_SAFE_INTEGER);
    eventScroll.scrollTop = Number.MAX_SAFE_INTEGER;
  }

  function followDetail(): void {
    const stream = selectedStream();
    if (stream?.kind === "thread" && detailMode === "harness") {
      followTail = true;
      const rows = transcriptRows(options.transcripts.get(stream.id));
      selectedTranscriptKey = rows.at(-1)?.key ?? null;
      rebuildHarness();
    } else followEvents();
  }

  function toggleExpanded(): void {
    const stream = selectedStream();
    const events = stream ? options.model.eventsFor(stream) : [];
    const event = events.find((candidate) => candidate.sequence === selectedEventSequence);
    if (!event) return;
    if (expanded.has(event.sequence)) expanded.delete(event.sequence);
    else expanded.add(event.sequence);
    const widget = eventBoxes.get(event.sequence);
    if (widget) widget.code.content = eventCode(event);
    renderer.requestRender();
  }

  function toggleTranscriptExpanded(): void {
    if (!selectedTranscriptKey) return;
    if (expandedTranscriptKeys.has(selectedTranscriptKey)) {
      expandedTranscriptKeys.delete(selectedTranscriptKey);
    } else expandedTranscriptKeys.add(selectedTranscriptKey);
    rebuildHarness();
  }

  function toggleTranscriptRaw(): void {
    if (!selectedTranscriptKey) return;
    if (rawTranscriptKeys.has(selectedTranscriptKey))
      rawTranscriptKeys.delete(selectedTranscriptKey);
    else rawTranscriptKeys.add(selectedTranscriptKey);
    rebuildHarness();
  }

  function toggleDetailExpanded(): void {
    const stream = selectedStream();
    if (stream?.kind === "thread" && detailMode === "harness") toggleTranscriptExpanded();
    else toggleExpanded();
  }

  function toggleDetailMode(): void {
    const stream = selectedStream();
    if (stream?.kind !== "thread") return;
    detailMode = detailMode === "harness" ? "frames" : "harness";
    showDetailSurface();
    updateChrome();
  }

  function onNewEvent(event: RawStreamEvent): void {
    const streamId = event.kind === "voice" ? VOICE_STREAM_ID : event.threadId;
    if (!streamId || view !== "detail" || streamId !== selectedStreamId) return;
    const stream = selectedStream();
    if (!stream) return;
    if (stream.kind === "voice") {
      rebuildEvents();
      return;
    }
    if (detailMode === "harness") {
      rebuildHarness();
      return;
    }
    const events = options.model.eventsFor(stream);
    const retained = new Set(events.map((candidate) => candidate.sequence));
    for (const [sequence, widget] of eventBoxes) {
      if (retained.has(sequence)) continue;
      eventScroll.remove(widget.box);
      widget.box.destroyRecursively();
      eventBoxes.delete(sequence);
      expanded.delete(sequence);
    }
    if (emptyEvents) {
      eventScroll.remove(emptyEvents);
      emptyEvents.destroyRecursively();
      emptyEvents = null;
    }
    if (!eventBoxes.has(event.sequence)) createEventWidget(event);

    const dropped = options.model.droppedEventsFor(stream);
    if (dropped > 0 && !droppedEvents) {
      droppedEvents = new core.TextRenderable(renderer, {
        id: "dropped-events",
        content: `${dropped} older events were evicted from this live view`,
        fg: TONES.faint,
      });
      eventScroll.add(droppedEvents, 0);
    } else if (droppedEvents) {
      droppedEvents.content = `${dropped} older events were evicted from this live view`;
    }

    if (followTail) {
      selectEventIndex(events.length - 1);
      eventScroll.scrollTop = Number.MAX_SAFE_INTEGER;
    } else if (!events.some((candidate) => candidate.sequence === selectedEventSequence)) {
      selectEventIndex(0);
    }
    updateChrome();
    renderer.requestRender();
  }

  let closed = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(refreshTimer);
    process.off("SIGTERM", shutdown);
    process.off("SIGHUP", shutdown);
    options.connection.close();
    renderer.destroy();
    syntaxStyle.destroy();
    options.onClosed();
    finish();
  };

  const refresh = async (reread = false): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      await options.refreshThreads(reread);
      connectionError = null;
      if (view === "list") rebuildThreadList();
      else if (selectedStream()) {
        updateDetailHeader();
        if (selectedStream()?.kind === "thread" && reread) {
          await hydrateSelectedTranscript(true);
        }
      } else closeDetail();
    } catch (error) {
      connectionError = error instanceof Error ? error.message : String(error);
    } finally {
      refreshing = false;
      updateChrome();
      renderer.requestRender();
    }
  };
  const refreshTimer = setInterval(() => void refresh(), 2_000);

  renderer.keyInput.on("keypress", (key) => {
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) {
      shutdown();
      return;
    }
    if (view === "list") {
      if (name === "j" || name === "down") updateThreadSelection(1);
      else if (name === "k" || name === "up") updateThreadSelection(-1);
      else if (name === "return" || name === "enter" || name === "right" || name === "l") {
        openDetail();
      } else if (name === "r") void refresh(true);
      else if (name === "g" || name === "home") updateThreadSelection(-Number.MAX_SAFE_INTEGER);
      else if (name === "G" || name === "end") updateThreadSelection(Number.MAX_SAFE_INTEGER);
      return;
    }
    if (name === "escape" || name === "backspace" || name === "left" || name === "h") {
      closeDetail();
    } else if (name === "j" || name === "down") {
      selectNextDetailItem();
    } else if (name === "k" || name === "up") {
      selectPreviousDetailItem();
    } else if (name === "return" || name === "enter" || name === "space") {
      toggleDetailExpanded();
    } else if (name === "v") {
      toggleDetailMode();
    } else if (name === "r" && selectedStream()?.kind === "thread" && detailMode === "harness") {
      toggleTranscriptRaw();
    } else if (name === "pagedown") {
      scrollEvents(12);
    } else if (name === "pageup") {
      scrollEvents(-12);
    } else if (name === "g" || name === "home") {
      followTail = false;
      if (selectedStream()?.kind === "thread" && detailMode === "harness") {
        harnessScroll.scrollTop = 0;
        selectTranscriptIndex(0);
      } else {
        eventScroll.scrollTop = 0;
        updateEventSelection(-Number.MAX_SAFE_INTEGER);
      }
    } else if (name === "G" || name === "end" || name === "f") {
      followDetail();
    }
  });

  renderer.on("resize", () => {
    if (view === "list") rebuildThreadList();
    else if (selectedStream()?.kind === "thread" && detailMode === "harness") rebuildHarness();
    updateDetailHeader();
    updateChrome();
  });

  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);

  // Expose the event hook after construction without coupling the connection
  // layer to OpenTUI types.
  options.setEventHandler(onNewEvent);
  rebuildThreadList();
  updateChrome();
  renderer.requestRender();
  await finished;
}
