import type { LifecycleFeed } from "../events/feed.ts";
import { recordingDirectory } from "./store.ts";
import { VoiceRecording } from "./writer.ts";

/** Installed before runtime startup; disk failures are visible without stopping healthy media. */
export function recordCall(
  feed: LifecycleFeed,
  stateDir: string,
  report: (message: string) => void,
) {
  let writer: VoiceRecording | undefined;
  let workspace: string | undefined;
  let threadId: string | undefined;
  let failed = false;
  const attempt = (write: () => void) => {
    if (failed) return;
    try {
      write();
    } catch (error) {
      failed = true;
      report(`Voice recording failed; transcript is incomplete: ${String(error)}`);
      try {
        writer?.gap("recording_failed");
      } catch {}
      try {
        writer?.close("error");
      } catch {}
    }
  };
  const unlisten = feed.listen((frame) =>
    attempt(() => {
      if (frame.event === "runtime.state.changed") {
        const runtime = feed.snapshot().runtime;
        if (runtime.workspace && runtime.mainThreadId) {
          if (workspace && (workspace !== runtime.workspace || threadId !== runtime.mainThreadId))
            throw new Error("Call recording identity changed");
          workspace = runtime.workspace;
          threadId = runtime.mainThreadId;
          writer ??= new VoiceRecording(workspace, recordingDirectory(stateDir, workspace));
          writer.openThread(threadId);
          if (runtime.phase === "failed") writer.gap("runtime_failed");
          if (runtime.phase === "quiescing") writer.gap("runtime_replacement_interrupted");
        }
      } else if (frame.event.startsWith("voice.item.")) {
        if (!writer || frame.data.threadId !== threadId)
          throw new Error("Voice event preceded verified call identity");
        writer.accept(frame);
      }
    }),
  );
  return {
    close(failedShutdown = false) {
      unlisten();
      attempt(() => {
        if (failedShutdown) writer?.gap("shutdown_failed");
        writer?.close(failedShutdown ? "error" : "stopped");
      });
    },
  };
}
