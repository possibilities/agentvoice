import { ChevronRightIcon, FileDiffIcon } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { useDisclosureState } from "@/transcript/disclosure-state";
import type { FileChange, Message } from "@/types/message";

const PierrePatchDiff = lazy(() => import("@/components/chat/pierre-diff"));

function patchLines(content: string, prefix: "+" | "-") {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (lines.length === 1 && lines[0] === "") return { count: 0, body: "" };
  return { count: lines.length, body: lines.map((line) => prefix + line).join("\n") };
}

function buildPatch(change: FileChange) {
  const diff = change.diff.replaceAll("\r\n", "\n").trimEnd();
  if (!diff) return null;
  if (/^(diff --git|---\s)/m.test(diff)) return diff + "\n";

  const oldPath = `a/${change.path}`;
  const newPath = `b/${change.movePath || change.path}`;
  if (diff.startsWith("@@")) {
    return `--- ${oldPath}\n+++ ${newPath}\n${diff}\n`;
  }

  if (change.kind === "add") {
    const { count, body } = patchLines(diff, "+");
    return count ? `--- /dev/null\n+++ ${newPath}\n@@ -0,0 +1,${count} @@\n${body}\n` : null;
  }

  if (change.kind === "delete") {
    const { count, body } = patchLines(diff, "-");
    return count ? `--- ${oldPath}\n+++ /dev/null\n@@ -1,${count} +0,0 @@\n${body}\n` : null;
  }

  return null;
}

function FileDisclosure({ change, disclosureId }: { change: FileChange; disclosureId: string }) {
  const [open, setOpen] = useDisclosureState(disclosureId);
  const patch = useMemo(() => buildPatch(change), [change]);
  const target = change.movePath ? `${change.path} → ${change.movePath}` : change.path;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="file-disclosure">
        <CollapsibleTrigger
          className="file-disclosure__trigger"
          disabled={!patch}
          data-open={open || undefined}
          aria-label={`${open ? "Collapse" : "Expand"} diff for ${target}`}
        >
          <ChevronRightIcon className="tool-disclosure__chevron" />
          <span className="file-disclosure__path" title={target}>
            {target}
          </span>
          <span className="file-disclosure__kind">{change.kind}</span>
          {!patch ? <span className="file-disclosure__note">no patch</span> : null}
        </CollapsibleTrigger>
        {patch ? (
          <CollapsibleContent className="file-disclosure__content">
            {change.diffTruncated ? (
              <p className="diff-truncated">
                Diff capped at 200,000 characters; the remainder is not loaded.
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

export function FileChangeMessage({ message }: { message: Message }) {
  const [open, setOpen] = useDisclosureState(`tool:${message.id}`);
  const changes = message.fileChanges ?? [];
  const activity = message.toolActivity;

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
            disabled={changes.length === 0}
            data-open={open || undefined}
          >
            <span className="tool-disclosure__name">
              {message.status === "error" ? "Failed · " : ""}Files
            </span>
            <span className="tool-disclosure__summary">{activity?.detail ?? message.content}</span>
            <span className="tool-disclosure__meta">
              {activity?.meta ?? `${changes.length} files`}
            </span>
            {changes.length ? <ChevronRightIcon className="tool-disclosure__chevron" /> : null}
          </CollapsibleTrigger>
          {changes.length ? (
            <CollapsibleContent className="file-change-event__content">
              {changes.map((change, index) => (
                <FileDisclosure
                  key={`${change.path}:${change.movePath ?? ""}:${index}`}
                  change={change}
                  disclosureId={`file:${message.id}:${change.path}:${change.movePath ?? ""}:${index}`}
                />
              ))}
            </CollapsibleContent>
          ) : null}
        </MarkerContent>
      </Marker>
    </Collapsible>
  );
}
