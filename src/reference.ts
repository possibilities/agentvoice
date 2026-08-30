export const CODEX_REFERENCE = {
  codexVersion: "codex-cli 0.151.0",
  voiceProtocol: "v3",
  voiceModel: "gpt-live-1-codex",
  voiceModelSelection: "app-server-v3-default",
  voice: "cove",
  orchestratorModel: "gpt-5.6-terra",
  reasoningEffort: "medium",
  includeStartupContext: true,
} as const;

/**
 * App-server does not expose the selected private voice model on the wire and
 * the subscription endpoint rejects an explicit session.model. Pinning the
 * binary version is therefore part of the reference-agent identity.
 */
export function assertCodexReferenceVersion(actual: string): void {
  if (actual !== CODEX_REFERENCE.codexVersion) {
    throw new Error(
      `Codex reference requires ${CODEX_REFERENCE.codexVersion}; got ${actual}. ` +
        "Re-verify the V3 default voice model before changing this pin.",
    );
  }
}

export function assertCodexReferenceVoiceModel(configured: string): void {
  if (configured !== CODEX_REFERENCE.voiceModel) {
    throw new Error(
      `Codex ${CODEX_REFERENCE.codexVersion} selects ${CODEX_REFERENCE.voiceModel} ` +
        `internally; scenario declared ${configured}. The private model cannot be overridden.`,
    );
  }
}
