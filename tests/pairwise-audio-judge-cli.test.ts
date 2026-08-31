import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquirePairwiseAudioJudgeLock,
  resolvePairwiseAudioJudgeApiKey,
  runPairwiseAudioJudgeCli,
} from "../src/pairwise-audio-judge-cli.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pairwise audio judge CLI safeguards", () => {
  test("holds an atomic sidecar lock until the owner releases it", () => {
    const directory = temporaryDirectory();
    const output = join(directory, "judgment.json");
    const first = acquirePairwiseAudioJudgeLock(output);

    expect(first.path).toBe(`${resolve(output)}.lock`);
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toMatchObject({
      kind: "voice-agent-pairwise-audio-judge-lock",
      output: resolve(output),
    });
    expect(() => acquirePairwiseAudioJudgeLock(output)).toThrow("atomic output lock");

    first.release();
    first.release();
    expect(existsSync(first.path)).toBe(false);

    const next = acquirePairwiseAudioJudgeLock(output);
    next.release();
    expect(existsSync(next.path)).toBe(false);
  });

  test("does not require or read a credential when both passes are resumed", () => {
    let lookups = 0;
    const apiKey = resolvePairwiseAudioJudgeApiKey(
      { resumePassOne: "pass-one.json", resumePassTwo: "pass-two.json" },
      () => {
        lookups++;
        return undefined;
      },
    );

    expect(apiKey).toBeUndefined();
    expect(lookups).toBe(0);
  });

  test("still requires a credential when either pass needs a provider response", () => {
    expect(() =>
      resolvePairwiseAudioJudgeApiKey({ resumePassOne: "pass-one.json" }, () => undefined),
    ).toThrow("OPENAI_API_KEY is not set");
    expect(resolvePairwiseAudioJudgeApiKey({}, () => "test-key")).toBe("test-key");
  });

  test("releases the sidecar lock when setup fails", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "judgment.json");

    expect(
      await runPairwiseAudioJudgeCli([
        join(directory, "missing-one"),
        join(directory, "missing-two"),
        "--output",
        output,
      ]),
    ).toBe(1);
    expect(existsSync(`${resolve(output)}.lock`)).toBe(false);
  });

  test("keeps prepare-only execution free of the output lock", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "judgment.json");

    expect(
      await runPairwiseAudioJudgeCli([
        join(directory, "missing-one"),
        join(directory, "missing-two"),
        "--output",
        output,
        "--prepare-only",
      ]),
    ).toBe(1);
    expect(existsSync(`${resolve(output)}.lock`)).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-pairwise-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}
