import { ChevronRightIcon, FileDiffIcon } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useDisclosureState } from "@/transcript/disclosure-state";
import type { FileChange, Message } from "@/types/message";
import { ToolActivityMessage } from "./tool-activity-message";

const PierrePatchDiff = lazy(() => import("@/components/chat/pierre-diff"));

interface DiffStats {
  added: number;
  removed: number;
}

function patchLines(content: string, prefix: "+" | "-") {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (lines.length === 1 && lines[0] === "") return { count: 0, body: "" };
  return { count: lines.length, body: lines.map((line) => prefix + line).join("\n") };
}

function diffStats(change: FileChange): DiffStats {
  if (change.kind === "add") return { added: patchLines(change.diff, "+").count, removed: 0 };
  if (change.kind === "delete") return { added: 0, removed: patchLines(change.diff, "-").count };
  let added = 0;
  let removed = 0;
  for (const line of change.diff.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function DiffCounts({ stats }: { stats: DiffStats }) {
  if (stats.added === 0 && stats.removed === 0) return null;
  return (
    <span
      className="file-diff-counts"
      aria-label={`${stats.added} lines added, ${stats.removed} lines removed`}
    >
      <span data-change="addition">+{stats.added}</span>
      <span data-change="deletion">−{stats.removed}</span>
    </span>
  );
}

function buildPatch(change: FileChange) {
  const diff = change.diff.replaceAll("\r\n", "\n");
  if (!diff) return null;
  const oldPath = `a/${change.path}`;
  const newPath = `b/${change.movePath || change.path}`;
  if (change.kind === "add") {
    const { count, body } = patchLines(diff, "+");
    return count ? `--- /dev/null\n+++ ${newPath}\n@@ -0,0 +1,${count} @@\n${body}\n` : null;
  }
  if (change.kind === "delete") {
    const { count, body } = patchLines(diff, "-");
    return count ? `--- ${oldPath}\n+++ /dev/null\n@@ -1,${count} +0,0 @@\n${body}\n` : null;
  }
  if (diff.startsWith("diff --git") || diff.startsWith("--- "))
    return diff.endsWith("\n") ? diff : `${diff}\n`;
  if (diff.startsWith("@@"))
    return `--- ${oldPath}\n+++ ${newPath}\n${diff}${diff.endsWith("\n") ? "" : "\n"}`;
  return null;
}

function changeKind(change: FileChange) {
  if (change.kind === "add") return "added";
  if (change.kind === "delete") return "deleted";
  if (change.movePath) return "renamed";
  return "edited";
}

function unavailableNote(change: FileChange) {
  if (change.diff) return "diff unavailable";
  if (change.kind === "add" || change.kind === "delete") return "empty file";
  if (change.movePath) return "path only";
  return "no diff";
}

function operationVerb(message: Message, changes: readonly FileChange[]) {
  const nativeStatus = message.toolActivity?.meta?.toLowerCase();
  if (nativeStatus === "declined") return "Declined";
  if (message.status === "error" || message.toolActivity?.state === "error") return "Failed";
  if (message.status === "working" || message.toolActivity?.state === "running") return "Editing";
  if (changes.length === 1) {
    const change = changes[0]!;
    if (change.kind === "add") return "Added";
    if (change.kind === "delete") return "Deleted";
    if (change.movePath && !change.diff) return "Renamed";
  }
  return "Edited";
}

function attachmentState(message: Message): "processing" | "error" | "done" {
  if (message.status === "error" || message.toolActivity?.state === "error") return "error";
  if (message.status === "working" || message.toolActivity?.state === "running")
    return "processing";
  return "done";
}

function FileAttachment({
  change,
  messageId,
  state,
}: {
  change: FileChange;
  messageId: string;
  state: "processing" | "error" | "done";
}) {
  const target = change.movePath ? `${change.path} → ${change.movePath}` : change.path;
  const disclosureId = `file:${messageId}:${change.path}:${change.movePath ?? ""}`;
  const [open, setOpen] = useDisclosureState(disclosureId);
  const patch = useMemo(() => buildPatch(change), [change]);
  const stats = useMemo(() => diffStats(change), [change]);
  const kind = changeKind(change);
  const note = patch ? undefined : unavailableNote(change);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <Attachment state={state} size="sm">
        <AttachmentMedia>
          <FileDiffIcon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle title={target}>{target}</AttachmentTitle>
          <AttachmentDescription>
            <span>{kind}</span>
            <DiffCounts stats={stats} />
            {note ? <span>{note}</span> : null}
          </AttachmentDescription>
        </AttachmentContent>
        {patch ? (
          <AttachmentActions>
            <CollapsibleTrigger
              render={<AttachmentAction />}
              aria-label={`${open ? "Collapse" : "Expand"} ${kind} file ${target}`}
            >
              <ChevronRightIcon data-icon="inline-end" className="tool-disclosure__chevron" />
            </CollapsibleTrigger>
          </AttachmentActions>
        ) : null}
      </Attachment>
      {patch ? (
        <CollapsibleContent className="pt-2 pb-3">
          {change.diffTruncated ? (
            <p className="diff-truncated">
              This diff was truncated by the source. The remainder is unavailable.
            </p>
          ) : null}
          {open ? (
            <Suspense fallback={<p className="diff-loading">Rendering diff…</p>}>
              <PierrePatchDiff patch={patch} />
            </Suspense>
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

export function FileChangeAttachments({ message }: { message: Message }) {
  const changes = message.fileChanges ?? [];
  const state = attachmentState(message);
  const verb = operationVerb(message, changes);
  const summary =
    changes.length === 1
      ? changes[0]!.movePath
        ? `${changes[0]!.path} → ${changes[0]!.movePath}`
        : changes[0]!.path
      : `${changes.length} ${changes.length === 1 ? "file" : "files"}`;
  return (
    <ToolActivityMessage
      message={{
        ...message,
        toolActivity: {
          ...message.toolActivity,
          name: "File change",
          detail: `${verb} ${summary}`,
          state: state === "processing" ? "running" : state === "done" ? "complete" : "error",
        },
      }}
    >
      <AttachmentGroup className="pt-2">
        {changes.map((change, index) => (
          <FileAttachment
            key={`${change.path}:${change.movePath ?? ""}:${index}`}
            change={change}
            messageId={`${message.id}:${index}`}
            state={state}
          />
        ))}
      </AttachmentGroup>
    </ToolActivityMessage>
  );
}
