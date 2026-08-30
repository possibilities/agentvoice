import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentWithoutOpenAiApiKey, localEnvValue, parseEnvValue } from "../src/local-env.ts";

describe("project-local environment", () => {
  test("parses ordinary, exported, and quoted values without comments", () => {
    expect(parseEnvValue("OPENAI_API_KEY=local-key\n", "OPENAI_API_KEY")).toBe("local-key");
    expect(parseEnvValue("export OPENAI_API_KEY='quoted-key'\n", "OPENAI_API_KEY")).toBe(
      "quoted-key",
    );
    expect(parseEnvValue("OPENAI_API_KEY=value # note\n", "OPENAI_API_KEY")).toBe("value");
  });

  test("prefers .env.local over an inherited stale value", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentvoice-env-test-"));
    try {
      writeFileSync(join(directory, ".env.local"), "OPENAI_API_KEY=valid-local\n", {
        mode: 0o600,
      });
      expect(
        localEnvValue("OPENAI_API_KEY", {
          directory,
          inherited: { OPENAI_API_KEY: "stale-inherited" },
        }),
      ).toBe("valid-local");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("falls back to the inherited environment when the local file omits the key", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentvoice-env-test-"));
    try {
      mkdirSync(join(directory, "nested"));
      expect(
        localEnvValue("OPENAI_API_KEY", {
          directory,
          inherited: { OPENAI_API_KEY: "inherited" },
        }),
      ).toBe("inherited");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("removes the OpenAI key from a copied subprocess environment", () => {
    const inherited = {
      OPENAI_API_KEY: "synthetic-secret",
      KEEP_ME: "present",
    };

    const environment = environmentWithoutOpenAiApiKey(inherited);

    expect(environment).toEqual({ KEEP_ME: "present" });
    expect(inherited).toHaveProperty("OPENAI_API_KEY", "synthetic-secret");
  });
});
