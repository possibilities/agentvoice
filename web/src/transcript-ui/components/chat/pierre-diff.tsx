import {
  type FileDiffMetadata,
  getFiletypeFromFileName,
  getSingularPatch,
  preloadHighlighter,
  registerCustomTheme,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useEffect, useState } from "react";

registerCustomTheme("arthack", async () => ({
  name: "arthack",
  type: "dark",
  colors: { "editor.background": "#111510", "editor.foreground": "#e5e7df" },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#969d91" },
    },
    {
      scope: ["keyword", "storage", "string"],
      settings: { foreground: "#c5e791" },
    },
    {
      scope: ["constant.numeric", "constant.language"],
      settings: { foreground: "#e1bd86" },
    },
  ],
}));

const options = {
  theme: "arthack",
  themeType: "dark",
  diffStyle: "unified",
  overflow: "scroll",
  disableFileHeader: true,
  unsafeCSS:
    ":host { --diffs-addition-color-override: #c5e791; --diffs-deletion-color-override: #ee7e89; }",
} as const;

export default function PierreDiff({ patch }: { patch: string }) {
  const [ready, setReady] = useState<{
    patch: string;
    diff?: FileDiffMetadata;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function prepare() {
      try {
        const diff = getSingularPatch(patch);
        // Initialize before React hydration: a cold no-worker renderer can
        // otherwise commit an empty <pre> without repainting its first diff.
        await preloadHighlighter({
          themes: ["arthack"],
          langs: [getFiletypeFromFileName(diff.name)],
        });
        if (!cancelled) setReady({ patch, diff });
      } catch {
        if (!cancelled)
          setReady({
            patch,
            error: "This patch could not be rendered. The original patch is shown below.",
          });
      }
    }
    void prepare();
    return () => {
      cancelled = true;
    };
  }, [patch]);
  if (ready?.patch !== patch)
    return (
      <p className="diff-loading" role="status">
        Opening diff…
      </p>
    );
  if (ready.error)
    return (
      <div className="tool-detail">
        <p className="diff-truncated">{ready.error}</p>
        <pre tabIndex={0} aria-label="Original patch">
          {patch}
        </pre>
      </div>
    );
  return (
    <div className="pierre-diff">
      <FileDiff fileDiff={ready.diff!} options={options} disableWorkerPool />
    </div>
  );
}
