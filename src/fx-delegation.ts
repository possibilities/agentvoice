import type { OrchestratorAdmission, OrchestratorTurnResult } from "./orchestrator-adapter.ts";

const ORCHESTRATOR_TURN_TIMEOUT_MS = 180_000;

/** The slice of an orchestrator adapter the delegation bridge needs. */
export interface DelegationOrchestrator {
  admit(text: string): Promise<OrchestratorAdmission>;
  waitForTurn(turnId: string, timeoutMs: number): Promise<OrchestratorTurnResult>;
}

export interface DelegationTelemetry {
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
}

export type DelegationHandoffPhase = "progress" | "result";
export type DelegationHandoff = (message: string, phase: DelegationHandoffPhase) => Promise<void>;

/**
 * Admits voice-agent delegations into one persistent Fx session. Queued work
 * returns progress immediately and publishes its result later; a second request
 * while Fx is active becomes genuine in-flight steering.
 */
export class FxDelegationController {
  constructor(
    private readonly orchestrator: DelegationOrchestrator,
    private readonly telemetry: DelegationTelemetry,
  ) {}

  async delegate(request: string, handoff: DelegationHandoff): Promise<void> {
    const admission = await this.orchestrator.admit(request);
    await this.telemetry.emit("delegation.created", {
      text: request,
      delegationTurnId: admission.delegationTurnId,
      disposition: admission.disposition,
      activeTurnId: admission.activeTurnId,
    });

    if (admission.disposition === "steering") {
      if (!admission.activeTurnId) {
        throw new Error("Fx admitted steering without identifying the active turn");
      }
      await handoff(
        "The new constraint was steered into the coding work already in progress. " +
          "Acknowledge it once in at most eight spoken words, then remain available; the original " +
          "delegation will deliver the final result.",
        "progress",
      );
      await this.telemetry.emit("delegation.steered", {
        delegationTurnId: admission.delegationTurnId,
        activeTurnId: admission.activeTurnId,
      });
      return;
    }

    await handoff(
      "The coding orchestrator accepted the request and is working in the background. " +
        "Acknowledge this once in at most eight spoken words, stay available for interruption, " +
        "and do not claim completion yet.",
      "progress",
    );
    let result: OrchestratorTurnResult;
    try {
      result = await this.orchestrator.waitForTurn(
        admission.delegationTurnId,
        ORCHESTRATOR_TURN_TIMEOUT_MS,
      );
      if (result.outcome !== "completed") {
        throw new Error(
          `Fx turn ${result.turnId} ended ${result.outcome}: ` +
            (result.assistantText || "no orchestrator report"),
        );
      }
    } catch (error) {
      await this.telemetry.emit("delegation.failed", {
        delegationTurnId: admission.delegationTurnId,
        message: errorMessage(error),
      });
      await handoff(
        "The coding orchestrator stopped without a completed result. Tell the user the work failed " +
          `and give this reason; do not claim completion:\n${errorMessage(error)}`,
        "result",
      );
      return;
    }

    await this.telemetry.emit("delegation.completed", {
      delegationTurnId: admission.delegationTurnId,
      turnId: result.turnId,
      outcome: result.outcome,
      providerDisposition: result.providerDisposition,
      assistantText: result.assistantText,
    });
    await handoff(
      "The coding orchestrator has finished. This result is authoritative and replaces the " +
        "earlier still-running progress update. Give the user an accurate spoken report now in at " +
        `most 80 words and four short sentences; do not say the work is still running.\n\n${
          result.assistantText || "The turn completed without a text report."
        }`,
      "result",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
