import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  type ProcessRecord,
  processIdentity,
  sameProcessIdentity,
} from "./core/owned-processes.ts";
import { lockFile } from "./core/thread-lock.ts";
import { type Environ, stateDirectory } from "./paths.ts";
import { ownedDirectory, ownedFile, safeAncestors } from "./private-files.ts";
import type { Launchctl, ServiceAction, ServiceOptions, ServiceSnapshot } from "./service.ts";

const HANDOFF_VERSION = 1;
const HELPER_PREFIX = "io.arthack.agentvoice.service-handoff.";
const ACCEPT_TIMEOUT_MS = 15_000;
const INITIATOR_EXIT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;

type HandoffAction = Extract<ServiceAction, "install" | "restart">;
type HandoffScope = "installer" | "service";
type HandoffState = "accepted" | "running" | "succeeded" | "failed";

interface SerializedServiceOptions {
  home: string;
  stateDir: string;
  uid: number;
  bun: string;
  entrypoint: string;
  env: Environ;
  packageRuntime: boolean;
}

export interface ServiceHandoffRequest {
  version: 1;
  operationId: string;
  scope: HandoffScope;
  action: HandoffAction;
  label: string;
  helperLabel: string;
  initiator: ProcessRecord;
  options: SerializedServiceOptions;
  installer?: { quitMenu: boolean; stateDir: string };
}

export interface ServiceHandoffStatus {
  version: 1;
  operationId: string;
  scope: HandoffScope;
  action: HandoffAction;
  state: HandoffState;
  updatedAt: string;
  snapshot?: ServiceSnapshot;
  error?: string;
}

export interface ServiceHandoffOutcome {
  kind: "handedOff";
  operationId: string;
  statusPath: string;
}

function handoffRoot(stateDir: string): string {
  return join(stateDir, "default", "service", "handoffs");
}

function statusPath(requestPath: string): string {
  return join(dirname(requestPath), "status.json");
}

function helperLogPath(requestPath: string): string {
  return join(dirname(requestPath), "helper.log");
}

function atomicPrivateWrite(path: string, contents: string): void {
  const stage = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(stage, contents, { flag: "wx", mode: 0o600 });
    renameSync(stage, path);
  } finally {
    if (lstatSync(stage, { throwIfNoEntry: false })) unlinkSync(stage);
  }
}

function selectedEnvironment(env: Environ): Environ {
  const selected: Environ = {};
  for (const key of [
    "PATH",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "CODEX_HOME",
    "CODEX_PATH",
    "AGENTROLES_HOME",
    "AGENTVOICE_INSTALL_BIN_DIR",
    "AGENTVOICE_INSTALL_STATE_DIR",
    "AGENTVOICE_INSTALL_APP_DIR",
    "BUN_INSTALL_CACHE_DIR",
    "BUN_CONFIG_NO_CLEAR_TERMINAL",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
  ]) {
    if (env[key] !== undefined) selected[key] = env[key];
  }
  return selected;
}

function serializeOptions(options: ServiceOptions): SerializedServiceOptions {
  return {
    home: options.home,
    stateDir: options.stateDir,
    uid: options.uid,
    bun: options.bun,
    entrypoint: options.entrypoint,
    env: selectedEnvironment(options.env),
    packageRuntime: options.packageRuntime === true,
  };
}

function readStatus(path: string): ServiceHandoffStatus | undefined {
  if (!ownedFile(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as ServiceHandoffStatus;
  if (
    value.version !== HANDOFF_VERSION ||
    typeof value.operationId !== "string" ||
    !["installer", "service"].includes(value.scope) ||
    !["install", "restart"].includes(value.action) ||
    !["accepted", "running", "succeeded", "failed"].includes(value.state)
  )
    throw new Error(`Invalid service handoff status: ${path}`);
  return value;
}

function matchingStatus(
  request: ServiceHandoffRequest,
  status: ServiceHandoffStatus | undefined,
): ServiceHandoffStatus | undefined {
  if (
    status &&
    (status.operationId !== request.operationId ||
      status.scope !== request.scope ||
      status.action !== request.action)
  )
    throw new Error("Service handoff status identity changed");
  return status;
}

function writeStatus(
  request: ServiceHandoffRequest,
  state: HandoffState,
  extra: object = {},
): void {
  atomicPrivateWrite(
    statusPath(join(handoffRoot(request.options.stateDir), request.operationId, "request.json")),
    `${JSON.stringify({
      version: HANDOFF_VERSION,
      operationId: request.operationId,
      scope: request.scope,
      action: request.action,
      state,
      updatedAt: new Date().toISOString(),
      ...extra,
    })}\n`,
  );
}

function parseRequest(requestPath: string): ServiceHandoffRequest {
  if (!isAbsolute(requestPath)) throw new Error("Service handoff request path must be absolute");
  safeAncestors(dirname(requestPath));
  if (!ownedFile(requestPath))
    throw new Error(`Service handoff request is missing: ${requestPath}`);
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as ServiceHandoffRequest;
  const operationIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    request.version !== HANDOFF_VERSION ||
    !operationIdPattern.test(request.operationId) ||
    !["installer", "service"].includes(request.scope) ||
    !["install", "restart"].includes(request.action) ||
    (request.scope === "installer" &&
      (request.action !== "install" ||
        typeof request.installer?.quitMenu !== "boolean" ||
        !isAbsolute(request.installer.stateDir) ||
        request.installer.stateDir !==
          (request.options.env["AGENTVOICE_INSTALL_STATE_DIR"] ??
            stateDirectory(request.options.env, request.options.home)))) ||
    (request.scope === "service" && request.installer !== undefined) ||
    request.helperLabel !== `${HELPER_PREFIX}${request.operationId}` ||
    request.label !== "io.arthack.agentvoice.server" ||
    request.options.uid !== process.getuid?.() ||
    request.options.packageRuntime !== true ||
    !isAbsolute(request.options.home) ||
    !isAbsolute(request.options.stateDir) ||
    !isAbsolute(request.options.bun) ||
    !isAbsolute(request.options.entrypoint) ||
    !Number.isSafeInteger(request.initiator.pid) ||
    request.initiator.pid <= 0 ||
    typeof request.initiator.birth !== "string" ||
    !request.initiator.birth
  )
    throw new Error(`Invalid service handoff request: ${requestPath}`);
  const expected = join(handoffRoot(request.options.stateDir), request.operationId, "request.json");
  if (requestPath !== expected)
    throw new Error(`Unexpected service handoff request path: ${requestPath}`);
  ownedDirectory(handoffRoot(request.options.stateDir));
  ownedDirectory(dirname(requestPath));
  for (const path of [request.options.bun, request.options.entrypoint]) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o022) !== 0
    )
      throw new Error(`Unsafe service handoff executable: ${path}`);
  }
  return request;
}

async function waitForInitiatorExit(identity: ProcessRecord): Promise<void> {
  const deadline = Date.now() + INITIATOR_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await processIdentity(identity.pid);
    if (!current || !sameProcessIdentity(current, identity)) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error("Service handoff initiator did not exit before the safety timeout");
}

async function submitHandoff(
  options: ServiceOptions,
  label: string,
  action: HandoffAction,
  scope: HandoffScope,
  installer?: { quitMenu: boolean; stateDir: string },
): Promise<ServiceHandoffOutcome> {
  const initiator = await processIdentity(process.pid);
  if (!initiator) throw new Error("Cannot establish the service handoff initiator identity");
  const operationId = randomUUID();
  const helperLabel = `${HELPER_PREFIX}${operationId}`;
  const root = handoffRoot(options.stateDir);
  ownedDirectory(root);
  const operationDirectory = join(root, operationId);
  mkdirSync(operationDirectory, { mode: 0o700 });
  ownedDirectory(operationDirectory);
  const requestPath = join(operationDirectory, "request.json");
  const request: ServiceHandoffRequest = {
    version: HANDOFF_VERSION,
    operationId,
    scope,
    action,
    label,
    helperLabel,
    initiator,
    options: serializeOptions(options),
    ...(installer ? { installer } : {}),
  };
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
  const log = helperLogPath(requestPath);
  writeFileSync(log, "", { flag: "wx", mode: 0o600 });
  const submitted = await options.launchctl([
    "submit",
    "-l",
    helperLabel,
    "-o",
    log,
    "-e",
    log,
    "--",
    options.bun,
    options.entrypoint,
    scope === "installer" ? "__installer-handoff" : "__service-handoff",
    requestPath,
  ]);
  if (submitted.code !== 0)
    throw new Error(`launchctl submit failed (${submitted.code}): ${submitted.err.trim()}`);

  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
  for (;;) {
    const status = readStatus(statusPath(requestPath));
    if (status?.operationId !== undefined && status.operationId !== operationId)
      throw new Error("Service handoff status identity changed");
    if (["accepted", "running", "succeeded"].includes(status?.state ?? ""))
      return { kind: "handedOff", operationId, statusPath: statusPath(requestPath) };
    if (status?.state === "failed") throw new Error(`Service handoff failed: ${status.error}`);
    if (Date.now() >= deadline) {
      const cancelled = await options.launchctl(["bootout", `gui/${options.uid}/${helperLabel}`]);
      if (cancelled.code !== 0 && cancelled.code !== 113)
        throw new Error(
          `Service handoff acceptance timed out and helper cancellation failed (${cancelled.code}); inspect ${statusPath(requestPath)}`,
        );
      throw new Error(`Service handoff was not accepted; inspect ${statusPath(requestPath)}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

export function submitServiceHandoff(
  options: ServiceOptions,
  label: string,
  action: HandoffAction,
): Promise<ServiceHandoffOutcome> {
  return submitHandoff(options, label, action, "service");
}

export function submitInstallerHandoff(
  options: ServiceOptions,
  label: string,
  quitMenu: boolean,
): Promise<ServiceHandoffOutcome> {
  const stateDir =
    options.env["AGENTVOICE_INSTALL_STATE_DIR"] ?? stateDirectory(options.env, options.home);
  return submitHandoff(options, label, "install", "installer", { quitMenu, stateDir });
}

export async function systemLaunchctl(args: string[]) {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(args[0] === "bootout" ? 75_000 : 15_000),
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

export async function runServiceHandoff(
  requestPath: string,
  dependencies: {
    launchctl?: Launchctl;
    waitForInitiatorExit?: (identity: ProcessRecord) => Promise<void>;
  } = {},
): Promise<ServiceHandoffStatus> {
  const request = parseRequest(requestPath);
  if (request.scope !== "service") throw new Error("Expected a service-scoped handoff request");
  const existing = matchingStatus(request, readStatus(statusPath(requestPath)));
  if (existing?.state === "succeeded" || existing?.state === "failed") return existing;
  try {
    const installLock = join(request.options.stateDir, ".install-lock");
    let releaseInstallLock: () => void;
    try {
      releaseInstallLock = lockFile(
        installLock,
        `Another AgentVoice installer is already in progress: ${installLock}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EISDIR")
        throw new Error(
          `Legacy install lock directory exists: ${installLock}; check for another installer before removing it`,
        );
      throw error;
    }
    try {
      const { VoiceService } = await import("./service.ts");
      const service = new VoiceService(
        { ...request.options, launchctl: dependencies.launchctl ?? systemLaunchctl },
        request.label,
      );
      await service.change(request.action, {
        forceDirect: true,
        onLocked: async () => {
          writeStatus(request, "accepted");
          await (dependencies.waitForInitiatorExit ?? waitForInitiatorExit)(request.initiator);
          writeStatus(request, "running");
        },
      });
      const snapshot = await service.snapshot();
      writeStatus(request, "succeeded", { snapshot });
    } finally {
      releaseInstallLock();
    }
  } catch (error) {
    writeStatus(request, "failed", { error: String(error).slice(0, 4096) });
  }
  return matchingStatus(request, readStatus(statusPath(requestPath)))!;
}

export async function runInstallerHandoff(
  requestPath: string,
  dependencies: {
    waitForInitiatorExit?: (identity: ProcessRecord) => Promise<void>;
    install?: (quitMenu: boolean) => Promise<void>;
  } = {},
): Promise<ServiceHandoffStatus> {
  const request = parseRequest(requestPath);
  if (request.scope !== "installer")
    throw new Error("Expected an installer-scoped handoff request");
  const existing = matchingStatus(request, readStatus(statusPath(requestPath)));
  if (existing?.state === "succeeded" || existing?.state === "failed") return existing;
  try {
    ownedDirectory(request.installer!.stateDir);
    const installLock = join(request.installer!.stateDir, ".install-lock");
    let releaseInstallLock: () => void;
    try {
      releaseInstallLock = lockFile(
        installLock,
        `Another AgentVoice installer is already in progress: ${installLock}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EISDIR")
        throw new Error(
          `Legacy install lock directory exists: ${installLock}; check for another installer before removing it`,
        );
      throw error;
    }
    try {
      writeStatus(request, "accepted");
      await (dependencies.waitForInitiatorExit ?? waitForInitiatorExit)(request.initiator);
      writeStatus(request, "running");
      if (dependencies.install) await dependencies.install(request.installer!.quitMenu);
      else {
        for (const key of [
          "PATH",
          "XDG_STATE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "CODEX_HOME",
          "CODEX_PATH",
          "AGENTROLES_HOME",
          "AGENTVOICE_INSTALL_BIN_DIR",
          "AGENTVOICE_INSTALL_STATE_DIR",
          "AGENTVOICE_INSTALL_APP_DIR",
          "BUN_INSTALL_CACHE_DIR",
          "BUN_CONFIG_NO_CLEAR_TERMINAL",
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_SYSTEM",
        ]) {
          const value = request.options.env[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        const { install } = await import("../scripts/install.ts");
        await install(undefined, undefined, {
          quitMenu: request.installer!.quitMenu,
          disableSelfHandoff: true,
          installLockAlreadyHeld: true,
        });
      }
      writeStatus(request, "succeeded");
    } finally {
      releaseInstallLock();
    }
  } catch (error) {
    writeStatus(request, "failed", { error: String(error).slice(0, 4096) });
  }
  return matchingStatus(request, readStatus(statusPath(requestPath)))!;
}

export async function retireServiceHandoffJob(requestPath: string): Promise<never> {
  const request = parseRequest(requestPath);
  Bun.spawn(["/bin/launchctl", "bootout", `gui/${request.options.uid}/${request.helperLabel}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await Bun.sleep(5_000);
  process.exit(1);
}
