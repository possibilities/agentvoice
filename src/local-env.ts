import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_ENV_BYTES = 64 * 1024;

/**
 * Reads one secret from the ignored project-local environment file, falling
 * back to the inherited process environment. The local file intentionally
 * wins so a stale shell export cannot shadow the credential the operator put
 * in this project.
 */
export function localEnvValue(
  name: string,
  options: { directory?: string; inherited?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const path = resolve(options.directory ?? process.cwd(), ".env.local");
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (bytes.length > MAX_ENV_BYTES) {
      throw new Error(`.env.local exceeds ${MAX_ENV_BYTES} bytes`);
    }
    const parsed = parseEnvValue(bytes.toString("utf8"), name);
    if (parsed !== undefined) return parsed;
  }
  const inherited = (options.inherited ?? process.env)[name];
  return inherited && inherited.length > 0 ? inherited : undefined;
}

export function environmentWithoutOpenAiApiKey(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited };
  delete environment["OPENAI_API_KEY"];
  return environment;
}

export function parseEnvValue(text: string, name: string): string | undefined {
  let result: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    result = decodeValue(match[2] ?? "");
  }
  return result && result.length > 0 ? result : undefined;
}

function decodeValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw.replace(/\s+#.*$/, "").trim();
}
