import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { CODEX_REFERENCE } from "./reference.ts";

export const DEFAULT_AGENT = {
  voiceModel: CODEX_REFERENCE.voiceModel,
  voice: CODEX_REFERENCE.voice,
  orchestratorModel: CODEX_REFERENCE.orchestratorModel,
  reasoningEffort: CODEX_REFERENCE.reasoningEffort,
  includeStartupContext: CODEX_REFERENCE.includeStartupContext,
} as const;

const playStepSchema = z.object({
  type: z.literal("play"),
  id: z.string().min(1),
  audio: z.string().min(1),
  transcript: z.string().min(1),
});

const waitStepSchema = z
  .object({
    type: z.literal("wait"),
    event: z.string().min(1),
    occurrence: z.number().int().positive().optional(),
    after: z
      .object({
        event: z.string().min(1),
        occurrence: z.number().int().positive(),
      })
      .optional(),
    timeoutMs: z.number().int().positive().default(180_000),
  })
  .refine((step) => (step.occurrence === undefined) !== (step.after === undefined), {
    message: "wait step must set exactly one of occurrence or after",
  });

const sleepStepSchema = z.object({
  type: z.literal("sleep"),
  ms: z.number().int().nonnegative(),
});

export const scenarioSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  workspace: z.string().min(1),
  agent: z
    .object({
      voiceModel: z.string().min(1).default(CODEX_REFERENCE.voiceModel),
      voice: z.string().min(1).default(CODEX_REFERENCE.voice),
      orchestratorModel: z.string().min(1).default(CODEX_REFERENCE.orchestratorModel),
      reasoningEffort: z.string().min(1).default(CODEX_REFERENCE.reasoningEffort),
      includeStartupContext: z.boolean().default(CODEX_REFERENCE.includeStartupContext),
    })
    .default(DEFAULT_AGENT),
  steps: z
    .array(z.discriminatedUnion("type", [playStepSchema, waitStepSchema, sleepStepSchema]))
    .min(1),
  oracle: z
    .object({
      command: z.array(z.string()).min(1),
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .optional(),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioStep = Scenario["steps"][number];

export interface LoadedScenario {
  path: string;
  directory: string;
  scenario: Scenario;
  workspace: string;
}

export async function loadScenario(path: string): Promise<LoadedScenario> {
  const absolutePath = resolve(path);
  const value = await Bun.file(absolutePath).json();
  const scenario = scenarioSchema.parse(value);
  const directory = dirname(absolutePath);
  return {
    path: absolutePath,
    directory,
    scenario,
    workspace: resolveFrom(directory, scenario.workspace),
  };
}

export function stepAudioPath(
  loaded: LoadedScenario,
  step: Extract<ScenarioStep, { type: "play" }>,
): string {
  return resolveFrom(loaded.directory, step.audio);
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : join(base, path);
}
