/**
 * Account profiles and balanced selection (opt-in via `accounts.balance`).
 *
 * A profile is a per-account `CODEX_HOME` under `<state>/accounts/<slug>/`:
 * a real `auth.json` (its own OAuth grant, refreshed only by codex — never
 * copy credentials between stores; refresh tokens rotate with server-side
 * reuse detection) plus symlinks to every other top-level entry of the
 * canonical `~/.codex`. The shared session store is what lets one thread
 * resume under any account; `scripts/account-profiles-probe.ts` re-verifies
 * that against the installed codex.
 *
 * Selection is delegated to the balancer CLI — `agentusage balance codex`
 * first, `codex-swap select` as fallback — and its pick is mapped to a
 * profile by account email. Transient refusals degrade to the canonical home;
 * balancing configured with codex-swap installed but nothing onboarded
 * refuses to boot, with instructions (`onboardingFailureMessage`).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Environ } from "../paths.ts";
import { stateDirectory } from "../paths.ts";

export const AUTH_FILE = "auth.json";
export const BALANCER_TIMEOUT_MS = 60_000;

export interface ProfileIdentity {
  email: string;
  accountId: string | null;
  plan: string | null;
}

export interface AccountProfile {
  slug: string;
  directory: string;
  identity: ProfileIdentity | null;
}

export function accountsDirectory(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "accounts");
}

// ---------------------------------------------------------------------------
// Pure: identity and balancer-output parsing
// ---------------------------------------------------------------------------

/**
 * Reads the grant's identity out of an auth.json id_token payload. Claims
 * only — token material never leaves this function.
 */
export function decodeIdentity(authJsonText: string): ProfileIdentity | null {
  try {
    const parsed = JSON.parse(authJsonText) as Record<string, unknown>;
    const tokens = parsed["tokens"] as Record<string, unknown> | undefined;
    const idToken = tokens?.["id_token"];
    if (typeof idToken !== "string") return null;
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const email = claims["email"];
    if (typeof email !== "string" || email.length === 0) return null;
    const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    const accountId = tokens?.["account_id"] ?? auth["chatgpt_account_id"];
    const plan = auth["chatgpt_plan_type"];
    return {
      email,
      accountId: typeof accountId === "string" ? accountId : null,
      plan: typeof plan === "string" ? plan : null,
    };
  } catch {
    return null;
  }
}

export type BalancerPick =
  | { kind: "account"; email: string; reason: string }
  | { kind: "refusal"; reason: string };

/** `agentusage balance codex --json`: a flat object with ok/email/reason. */
export function parseAgentusageBalance(stdout: string): BalancerPick | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed["ok"] === true && typeof parsed["email"] === "string") {
      return {
        kind: "account",
        email: parsed["email"],
        reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "balanced",
      };
    }
    if (parsed["ok"] === false) {
      const refusal = parsed["refusal"];
      const detail = parsed["detail"];
      return {
        kind: "refusal",
        reason: [refusal, detail].filter((part) => typeof part === "string").join(": "),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** `codex-swap select --json`: a versioned envelope; email rides the selection. */
export function parseCodexSwapSelect(stdout: string): BalancerPick | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const error = parsed["error"] as Record<string, unknown> | null | undefined;
    if (error && typeof error === "object") {
      return {
        kind: "refusal",
        reason: typeof error["message"] === "string" ? error["message"] : "selection refused",
      };
    }
    const data = parsed["data"] as Record<string, unknown> | null | undefined;
    const selection = data?.["selection"] as Record<string, unknown> | undefined;
    const email = selection?.["email"];
    if (typeof email === "string" && email.length > 0) {
      const reason = selection?.["reason"];
      return {
        kind: "account",
        email,
        reason: typeof reason === "string" ? reason : "selected",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** The binding utilization out of an `account/rateLimits/updated` payload. */
export function maxUsedPercent(params: Record<string, unknown>): number | null {
  const snapshot = params["rateLimits"] as Record<string, unknown> | undefined;
  if (!snapshot) return null;
  let max: number | null = null;
  for (const key of ["primary", "secondary"]) {
    const window = snapshot[key] as Record<string, unknown> | null | undefined;
    const used = window?.["usedPercent"];
    if (typeof used === "number" && (max === null || used > max)) max = used;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Profile discovery and the symlink farm
// ---------------------------------------------------------------------------

/**
 * Makes `profileDir` a faithful view of the canonical home: every top-level
 * entry symlinked except auth.json, which stays the profile's own. Runs at
 * every spawn so state files codex grows later never drift: a real entry the
 * canonical home lacks is adopted (moved) into it; a real entry both have is
 * set aside as `<name>.superseded`; dangling links are pruned.
 */
export function reconcileFarm(
  canonicalHome: string,
  profileDir: string,
  warn: (message: string) => void = () => {},
): void {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const canonicalEntries = new Set(readdirSync(canonicalHome));
  for (const entry of readdirSync(profileDir)) {
    // Set-aside copies stay quarantined in the profile, never adopted.
    if (entry === AUTH_FILE || entry.endsWith(".superseded")) continue;
    const path = join(profileDir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = join(canonicalHome, entry);
      if (!canonicalEntries.has(entry) || readlinkSync(path) !== target) rmSync(path);
      continue;
    }
    if (canonicalEntries.has(entry)) {
      const aside = `${entry}.superseded`;
      rmSync(join(profileDir, aside), { recursive: true, force: true });
      renameSync(path, join(profileDir, aside));
      warn(`profile entry ${entry} shadowed canonical state; set aside as ${aside}`);
    } else {
      renameSync(path, join(canonicalHome, entry));
      canonicalEntries.add(entry);
      warn(`profile entry ${entry} adopted into the canonical home`);
    }
  }
  for (const entry of canonicalEntries) {
    if (entry === AUTH_FILE) continue;
    const path = join(profileDir, entry);
    if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      symlinkSync(join(canonicalHome, entry), path);
    }
  }
}

/** Profiles under the accounts directory; identity is null until logged in. */
export function discoverProfiles(accountsDir: string): AccountProfile[] {
  let slugs: string[];
  try {
    slugs = readdirSync(accountsDir).filter((entry) =>
      lstatSync(join(accountsDir, entry)).isDirectory(),
    );
  } catch {
    return [];
  }
  return slugs.sort().map((slug) => {
    const directory = join(accountsDir, slug);
    let identity: ProfileIdentity | null = null;
    try {
      identity = decodeIdentity(readFileSync(join(directory, AUTH_FILE), "utf8"));
    } catch {
      // no auth.json yet — the profile exists but cannot be selected
    }
    return { slug, directory, identity };
  });
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface BalancerRun {
  exitCode: number | null;
  stdout: string;
}

export type RunBalancer = (argv: string[], timeoutMs: number) => Promise<BalancerRun>;

export type AccountSelection =
  | { kind: "profile"; profile: AccountProfile; email: string; reason: string }
  | { kind: "canonical"; reason: string };

/**
 * One selection pass: agentusage first, codex-swap as fallback, canonical on
 * any refusal. Balancer stdout is parsed defensively — an unparseable pick
 * degrades, never throws.
 */
export async function selectAccount(
  profiles: AccountProfile[],
  run: RunBalancer,
): Promise<AccountSelection> {
  const usable = profiles.filter((profile) => profile.identity !== null);
  if (usable.length === 0) {
    return { kind: "canonical", reason: "no logged-in account profiles" };
  }

  const attempts: Array<{ argv: string[]; parse(stdout: string): BalancerPick | null }> = [
    { argv: ["agentusage", "balance", "codex", "--json"], parse: parseAgentusageBalance },
    { argv: ["codex-swap", "select", "--json"], parse: parseCodexSwapSelect },
  ];
  let lastReason = "no balancer CLI available";
  for (const attempt of attempts) {
    let result: BalancerRun;
    try {
      result = await run(attempt.argv, BALANCER_TIMEOUT_MS);
    } catch (error) {
      lastReason = `${attempt.argv[0]}: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    const pick = attempt.parse(result.stdout);
    if (pick === null) {
      lastReason = `${attempt.argv[0]}: unparseable output (exit ${result.exitCode})`;
      continue;
    }
    if (pick.kind === "refusal") {
      return { kind: "canonical", reason: `${attempt.argv[0]} refused: ${pick.reason}` };
    }
    const profile = usable.find((candidate) => candidate.identity?.email === pick.email);
    if (!profile) {
      return {
        kind: "canonical",
        reason: `no account profile for ${pick.email}; run \`agentvoice accounts add\``,
      };
    }
    return { kind: "profile", profile, email: pick.email, reason: pick.reason };
  }
  return { kind: "canonical", reason: lastReason };
}

/** Default balancer runner: spawn, bounded, stdout captured, stderr passed. */
export async function runBalancerCommand(argv: string[], timeoutMs: number): Promise<BalancerRun> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const stdout = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Onboarding guidance
// ---------------------------------------------------------------------------

export interface PoolAccount {
  email: string;
  label: string | null;
}

/** `codex-swap accounts --json`: the registered pool, secret-free. */
export function parseCodexSwapAccounts(stdout: string): PoolAccount[] {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = parsed["data"] as Record<string, unknown> | null | undefined;
    const accounts = data?.["accounts"];
    if (!Array.isArray(accounts)) return [];
    const pool: PoolAccount[] = [];
    for (const entry of accounts) {
      const account = entry as Record<string, unknown>;
      const email = account["email"];
      if (typeof email !== "string" || email.length === 0) continue;
      const label = account["label"];
      pool.push({ email, label: typeof label === "string" ? label : null });
    }
    return pool;
  } catch {
    return [];
  }
}

/** A slug proposal from the email's local part, held to the slug charset. */
export function suggestSlug(email: string): string {
  const local = email.split("@")[0] ?? "";
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "account";
}

export function balancerCliPresent(): boolean {
  return Bun.which("codex-swap") !== null || Bun.which("agentusage") !== null;
}

/** Best-effort pool listing for guidance; failures mean an empty list. */
export async function listPoolAccounts(
  run: RunBalancer = runBalancerCommand,
): Promise<PoolAccount[]> {
  try {
    const result = await run(["codex-swap", "accounts", "--json"], BALANCER_TIMEOUT_MS);
    return parseCodexSwapAccounts(result.stdout);
  } catch {
    return [];
  }
}

/**
 * One `accounts add` line per pool account that has no logged-in profile
 * yet. Empty when everything is mapped — or when the pool is unreadable, so
 * absence of guidance never blocks anything.
 */
export function onboardingCommands(pool: PoolAccount[], profiles: AccountProfile[]): string[] {
  const mapped = new Set(
    profiles.flatMap((profile) => (profile.identity ? [profile.identity.email] : [])),
  );
  return pool
    .filter((account) => !mapped.has(account.email))
    .map((account) => {
      const label = account.label ? `  (${account.label})` : "";
      return `agentvoice accounts add ${suggestSlug(account.email)}   # ${account.email}${label}`;
    });
}

/**
 * The boot refusal for balance-on with nothing onboarded: exiting with
 * instructions beats silently running single-account on a machine that
 * clearly has a multi-account setup.
 */
export function onboardingFailureMessage(pool: PoolAccount[]): string {
  const commands =
    pool.length > 0
      ? onboardingCommands(pool, [])
      : ["agentvoice accounts add <slug>   # one per ChatGPT account"];
  return [
    "accounts.balance is on, but no account profile is logged in.",
    "",
    "Each ChatGPT account needs a one-time profile login — its own grant;",
    "credentials are never copied from codex-swap:",
    "",
    ...commands.map((command) => `  ${command}`),
    "",
    "Each login binds its profile to whichever account approves the device",
    "code, so use a browser window signed into the account you mean.",
    "Then restart the server. To run single-account instead, set",
    "accounts.balance: false.",
  ].join("\n");
}
