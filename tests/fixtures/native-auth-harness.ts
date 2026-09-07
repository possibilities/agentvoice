/** Fake native boundary; captures only the test-supplied home, never credentials. */
import { runtimeHarness } from "./runtime-harness.ts";

const h = runtimeHarness();
try {
  await h.runtime.start();
  const env = h.native.options.env!;
  const codexHome = env["CODEX_HOME"] ?? null;
  const hasCodexHome = Object.hasOwn(env, "CODEX_HOME");
  console.log(JSON.stringify({ codexHome, hasCodexHome }));
} finally {
  await h.cleanup();
}
