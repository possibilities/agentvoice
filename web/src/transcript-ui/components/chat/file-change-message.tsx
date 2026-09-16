import { ChevronRightIcon, FileDiffIcon } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { useDisclosureState } from "@/transcript/disclosure-state";
import type { FileChange, Message, ToolDetailSection } from "@/types/message";

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

function totalStats(changes: readonly FileChange[]) {
  return changes.reduce(
    (total, change) => {
      const current = diffStats(change);
      return { added: total.added + current.added, removed: total.removed + current.removed };
    },
    { added: 0, removed: 0 },
  );
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
  if (diff.startsWith("diff --git") || diff.startsWith("--- ")) {
    return diff.endsWith("\n") ? diff : `${diff}\n`;
  }
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

function FileDisclosure({ change, disclosureId }: { change: FileChange; disclosureId: string }) {
  const [open, setOpen] = useDisclosureState(disclosureId);
  const patch = useMemo(() => buildPatch(change), [change]);
  const stats = useMemo(() => diffStats(change), [change]);
  const target = change.movePath ? `${change.path} → ${change.movePath}` : change.path;
  const kind = changeKind(change);
  const note = patch ? undefined : unavailableNote(change);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="file-disclosure">
        <CollapsibleTrigger
          className="file-disclosure__trigger"
          disabled={!patch}
          data-open={open || undefined}
          aria-label={
            patch
              ? `${open ? "Collapse" : "Expand"} ${kind} file ${target}`
              : `${kind} file ${target}: ${note}`
          }
        >
          <ChevronRightIcon className="tool-disclosure__chevron" />
          <span className="file-disclosure__path" title={target}>
            {target}
          </span>
          <span className="file-disclosure__meta">
            <span className="file-disclosure__kind">{kind}</span>
            <DiffCounts stats={stats} />
            {note ? <span className="file-disclosure__note">{note}</span> : null}
          </span>
        </CollapsibleTrigger>
        {patch ? (
          <CollapsibleContent className="file-disclosure__content">
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
      </div>
    </Collapsible>
  );
}

function FileDetails({
  sections,
  disclosureId,
}: {
  sections: ToolDetailSection[];
  disclosureId: string;
}) {
  const [open, setOpen] = useDisclosureState(disclosureId);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="file-disclosure file-change-details">
        <CollapsibleTrigger
          className="file-disclosure__trigger"
          data-open={open || undefined}
          aria-label={`${open ? "Collapse" : "Expand"} original file operation details`}
        >
          <ChevronRightIcon className="tool-disclosure__chevron" />
          <span className="file-disclosure__path">Original details</span>
          <span className="file-disclosure__meta">
            {sections.length} {sections.length === 1 ? "section" : "sections"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="file-disclosure__content">
          {open
            ? sections.map((section, index) => (
                <section key={`${section.label}:${index}`} className="tool-detail">
                  <h4>{section.label}</h4>
                  <pre tabIndex={0} aria-label={section.label}>
                    {section.content}
                  </pre>
                </section>
              ))
            : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function FileChangeMessage({ message }: { message: Message }) {
  const [open, setOpen] = useDisclosureState(`tool:${message.id}`, true);
  const changes = message.fileChanges ?? [];
  const activity = message.toolActivity;
  const sections = activity?.sections?.filter((section) => section.content.trim()) ?? [];
  const verb = operationVerb(message, changes);
  const summary =
    changes.length === 1
      ? changes[0]!.movePath
        ? `${changes[0]!.path} → ${changes[0]!.movePath}`
        : changes[0]!.path
      : `${changes.length} ${changes.length === 1 ? "file" : "files"}`;
  const stats = totalStats(changes);
  const running = message.status === "working" || activity?.state === "running";
  const hasDetails = changes.length > 0 || sections.length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Marker
        variant="border"
        className="tool-disclosure file-change-event"
        data-error={message.status === "error" || undefined}
      >
        <MarkerIcon>
          <FileDiffIcon />
        </MarkerIcon>
        <MarkerContent>
          <CollapsibleTrigger
            className="tool-disclosure__trigger"
            disabled={!hasDetails}
            data-open={open || undefined}
            aria-label={`${open ? "Collapse" : "Expand"} file operation: ${verb} ${summary}`}
          >
            <span className="tool-disclosure__name">{verb}</span>
            <span className="tool-disclosure__summary">{summary}</span>
            <span className="tool-disclosure__meta">
              <DiffCounts stats={stats} />
              {running ? <span className="telemetry-live">running</span> : null}
            </span>
            {hasDetails ? <ChevronRightIcon className="tool-disclosure__chevron" /> : null}
          </CollapsibleTrigger>
          {hasDetails ? (
            <CollapsibleContent className="file-change-event__content">
              {open ? (
                <>
                  {changes.map((change, index) => (
                    <FileDisclosure
                      key={`${change.path}:${change.movePath ?? ""}:${index}`}
                      change={change}
                      disclosureId={`file:${message.id}:${change.path}:${change.movePath ?? ""}:${index}`}
                    />
                  ))}
                  {sections.length > 0 ? (
                    <FileDetails sections={sections} disclosureId={`file-details:${message.id}`} />
                  ) : null}
                </>
              ) : null}
            </CollapsibleContent>
          ) : null}
        </MarkerContent>
      </Marker>
    </Collapsible>
  );
}
