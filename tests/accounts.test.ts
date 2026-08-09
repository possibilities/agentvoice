import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountsDirectory,
  type BalancerRun,
  decodeIdentity,
  discoverProfiles,
  maxUsedPercent,
  parseAgentusageBalance,
  parseCodexSwapSelect,
  reconcileFarm,
  selectAccount,
} from "../src/server/accounts.ts";

function fakeAuthJson(email: string, accountId = "acct-1", plan = "plus"): string {
  const claims = {
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: plan },
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { id_token: `h.${payload}.s`, account_id: accountId },
  });
}

describe("decodeIdentity", () => {
  test("reads email, account id, and plan from the id_token claims", () => {
    expect(decodeIdentity(fakeAuthJson("a@b.c", "acct-9", "pro"))).toEqual({
      email: "a@b.c",
      accountId: "acct-9",
      plan: "pro",
    });
  });

  test("returns null for garbage, missing tokens, or missing email", () => {
    expect(decodeIdentity("not json")).toBeNull();
    expect(decodeIdentity("{}")).toBeNull();
    const noEmail = Buffer.from(JSON.stringify({})).toString("base64url");
    expect(decodeIdentity(JSON.stringify({ tokens: { id_token: `h.${noEmail}.s` } }))).toBeNull();
  });
});

describe("balancer output parsing", () => {
  test("agentusage: a pick carries email and reason", () => {
    expect(
      parseAgentusageBalance(
        JSON.stringify({ ok: true, email: "a@b.c", reason: "least loaded", accountKey: "k" }),
      ),
    ).toEqual({ kind: "account", email: "a@b.c", reason: "least loaded" });
  });

  test("agentusage: a refusal keeps its reason, garbage is null", () => {
    expect(
      parseAgentusageBalance(JSON.stringify({ ok: false, refusal: "observation-stale" })),
    ).toEqual({ kind: "refusal", reason: "observation-stale" });
    expect(parseAgentusageBalance("nope")).toBeNull();
    expect(parseAgentusageBalance(JSON.stringify({ ok: true }))).toBeNull();
  });

  test("codex-swap: email rides data.selection; error envelope refuses", () => {
    expect(
      parseCodexSwapSelect(
        JSON.stringify({
          schemaVersion: 1,
          data: { selection: { accountKey: "k", email: "a@b.c", reason: "headroom" } },
          error: null,
        }),
      ),
    ).toEqual({ kind: "account", email: "a@b.c", reason: "headroom" });
    expect(
      parseCodexSwapSelect(
        JSON.stringify({ data: null, error: { code: "NO_ELIGIBLE_ACCOUNT", message: "none" } }),
      ),
    ).toEqual({ kind: "refusal", reason: "none" });
    expect(parseCodexSwapSelect(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe("maxUsedPercent", () => {
  test("takes the worse of the two windows and tolerates absences", () => {
    expect(
      maxUsedPercent({
        rateLimits: { primary: { usedPercent: 40 }, secondary: { usedPercent: 97 } },
      }),
    ).toBe(97);
    expect(maxUsedPercent({ rateLimits: { primary: { usedPercent: 12 }, secondary: null } })).toBe(
      12,
    );
    expect(maxUsedPercent({ rateLimits: {} })).toBeNull();
    expect(maxUsedPercent({})).toBeNull();
  });
});

describe("accountsDirectory", () => {
  test("lives under the state directory", () => {
    expect(accountsDirectory({}, "/home/t")).toBe("/home/t/.local/state/agentvoice/accounts");
  });
});

describe("reconcileFarm and discoverProfiles", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function setup(): { canonical: string; profile: string } {
    root = mkdtempSync(join(tmpdir(), "agentvoice-accounts-test-"));
    const canonical = join(root, "codex");
    const profile = join(root, "accounts", "personal");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "auth.json"), fakeAuthJson("canonical@x.y"));
    writeFileSync(join(canonical, "config.toml"), "model = 'x'\n");
    mkdirSync(join(canonical, "sessions"));
    return { canonical, profile };
  }

  test("links every canonical entry except auth.json", () => {
    const { canonical, profile } = setup();
    reconcileFarm(canonical, profile);
    expect(readlinkSync(join(profile, "config.toml"))).toBe(join(canonical, "config.toml"));
    expect(readlinkSync(join(profile, "sessions"))).toBe(join(canonical, "sessions"));
    expect(existsSync(join(profile, "auth.json"))).toBe(false);
  });

  test("prunes dangling links and adopts real entries the canonical home lacks", () => {
    const { canonical, profile } = setup();
    reconcileFarm(canonical, profile);
    symlinkSync(join(canonical, "gone"), join(profile, "gone"));
    writeFileSync(join(profile, "grown.sqlite"), "state");
    reconcileFarm(canonical, profile);
    expect(lstatSync(join(profile, "gone"), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(canonical, "grown.sqlite"), "utf8")).toBe("state");
    expect(readlinkSync(join(profile, "grown.sqlite"))).toBe(join(canonical, "grown.sqlite"));
  });

  test("sets aside a real entry that shadows canonical state and leaves it quarantined", () => {
    const { canonical, profile } = setup();
    reconcileFarm(canonical, profile);
    rmSync(join(profile, "config.toml"));
    writeFileSync(join(profile, "config.toml"), "model = 'stale'\n");
    const warnings: string[] = [];
    reconcileFarm(canonical, profile, (message) => warnings.push(message));
    expect(readlinkSync(join(profile, "config.toml"))).toBe(join(canonical, "config.toml"));
    expect(readFileSync(join(profile, "config.toml.superseded"), "utf8")).toBe("model = 'stale'\n");
    expect(warnings.some((w) => w.includes("config.toml"))).toBe(true);
    reconcileFarm(canonical, profile);
    expect(existsSync(join(canonical, "config.toml.superseded"))).toBe(false);
  });

  test("keeps the profile's own auth.json and reads its identity", () => {
    const { canonical, profile } = setup();
    reconcileFarm(canonical, profile);
    writeFileSync(join(profile, "auth.json"), fakeAuthJson("me@profile.z", "acct-7", "pro"));
    reconcileFarm(canonical, profile);
    expect(lstatSync(join(profile, "auth.json")).isSymbolicLink()).toBe(false);
    const profiles = discoverProfiles(join(root, "accounts"));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.identity).toEqual({
      email: "me@profile.z",
      accountId: "acct-7",
      plan: "pro",
    });
  });

  test("a profile without auth.json is discovered but has no identity", () => {
    const { canonical, profile } = setup();
    reconcileFarm(canonical, profile);
    expect(discoverProfiles(join(root, "accounts"))[0]?.identity).toBeNull();
    expect(discoverProfiles(join(root, "missing"))).toEqual([]);
  });
});

describe("selectAccount", () => {
  const profile = (slug: string, email: string | null) => ({
    slug,
    directory: `/profiles/${slug}`,
    identity: email === null ? null : { email, accountId: null, plan: null },
  });
  const runner =
    (responses: Record<string, BalancerRun | Error>) =>
    async (argv: string[]): Promise<BalancerRun> => {
      const response = responses[argv[0] ?? ""];
      if (response === undefined) throw new Error(`unexpected ${argv[0]}`);
      if (response instanceof Error) throw response;
      return response;
    };

  test("no logged-in profiles means canonical without consulting a balancer", async () => {
    const selection = await selectAccount([profile("empty", null)], async () => {
      throw new Error("must not run");
    });
    expect(selection).toEqual({ kind: "canonical", reason: "no logged-in account profiles" });
  });

  test("maps the agentusage pick to a profile by email", async () => {
    const selection = await selectAccount(
      [profile("a", "a@x.y"), profile("b", "b@x.y")],
      runner({
        agentusage: {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, email: "b@x.y", reason: "least loaded" }),
        },
      }),
    );
    expect(selection).toEqual({
      kind: "profile",
      profile: profile("b", "b@x.y"),
      email: "b@x.y",
      reason: "least loaded",
    });
  });

  test("falls back to codex-swap when agentusage is missing", async () => {
    const selection = await selectAccount(
      [profile("a", "a@x.y")],
      runner({
        agentusage: new Error("spawn agentusage ENOENT"),
        "codex-swap": {
          exitCode: 0,
          stdout: JSON.stringify({ data: { selection: { email: "a@x.y", reason: "headroom" } } }),
        },
      }),
    );
    expect(selection.kind).toBe("profile");
  });

  test("a pick with no matching profile degrades to canonical, named", async () => {
    const selection = await selectAccount(
      [profile("a", "a@x.y")],
      runner({
        agentusage: { exitCode: 0, stdout: JSON.stringify({ ok: true, email: "other@x.y" }) },
      }),
    );
    expect(selection.kind).toBe("canonical");
    if (selection.kind === "canonical") expect(selection.reason).toContain("other@x.y");
  });

  test("a refusal and a double failure both degrade to canonical", async () => {
    const refused = await selectAccount(
      [profile("a", "a@x.y")],
      runner({
        agentusage: { exitCode: 3, stdout: JSON.stringify({ ok: false, refusal: "no-capacity" }) },
      }),
    );
    expect(refused.kind).toBe("canonical");
    const dead = await selectAccount(
      [profile("a", "a@x.y")],
      runner({
        agentusage: new Error("spawn agentusage ENOENT"),
        "codex-swap": new Error("spawn codex-swap ENOENT"),
      }),
    );
    expect(dead.kind).toBe("canonical");
  });
});
