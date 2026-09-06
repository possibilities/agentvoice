import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Socket } from "bun";
import { controlSocketPath } from "./socket.ts";
import { CONTROL_MCP_PATH, CONTROL_PROTOCOL_VERSION, type ControlStatus } from "./types.ts";

const DISCOVERY_VERSION = 1;
const MAX_RECORDS = 128;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_STATUS_BYTES = 1 << 20;
const PROBE_TIMEOUT_MS = 750;

export type ControlDiscoveryDescriptor = {
  version: typeof DISCOVERY_VERSION;
  instanceId: string;
  controllerPid: number;
  socketPath: string;
  url: string;
  token: string;
};

type PublishedDescriptor = {
  path: string;
  device: number;
  inode: number;
};

export type McpConnectionConfig = {
  mcpServers: {
    agentvoice: {
      type: "http";
      url: string;
      headers: { Authorization: string };
    };
  };
};

const uid = () => process.getuid?.() ?? 0;

function discoveryDirectory(stateDir: string): string {
  return join(stateDir, "control", "instances");
}

function descriptorPath(stateDir: string, instanceId: string): string {
  const name = createHash("sha256").update(instanceId).digest("hex");
  return join(discoveryDirectory(stateDir), `${name}.json`);
}

function assertPrivateDirectory(path: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(`unsafe AgentVoice discovery directory: ${path}`);
}

function assertPrivateFile(path: string): Stats {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    info.nlink !== 1 ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(`unsafe AgentVoice discovery record: ${path}`);
  return info;
}

function readPrivateFile(path: string, expected: Stats): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.uid !== uid() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0 ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    )
      throw new Error(`unsafe AgentVoice discovery record: ${path}`);
    const content = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
    const bytes = readSync(fd, content, 0, content.byteLength, 0);
    if (bytes > MAX_DESCRIPTOR_BYTES) return "";
    return content.subarray(0, bytes).toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isDescriptor(value: unknown, stateDir: string): value is ControlDiscoveryDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        !["version", "instanceId", "controllerPid", "socketPath", "url", "token"].includes(key),
    ) ||
    record["version"] !== DISCOVERY_VERSION ||
    typeof record["instanceId"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record["instanceId"]) ||
    !Number.isSafeInteger(record["controllerPid"]) ||
    (record["controllerPid"] as number) <= 0 ||
    typeof record["socketPath"] !== "string" ||
    !isAbsolute(record["socketPath"]) ||
    record["socketPath"] !== controlSocketPath(stateDir, record["instanceId"]) ||
    typeof record["url"] !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(record["url"]) ||
    typeof record["token"] !== "string" ||
    !/^[A-Za-z0-9_-]{16,512}$/.test(record["token"])
  )
    return false;
  try {
    const parsed = new URL(record["url"]);
    if (
      parsed.pathname !== CONTROL_MCP_PATH ||
      Number(parsed.port) < 1 ||
      Number(parsed.port) > 65535
    )
      return false;
  } catch {
    return false;
  }
  return true;
}

/** Publish only immutable transport facts; live workspace/thread identity comes from the UDS. */
export function publishControlDescriptor(
  stateDir: string,
  descriptor: ControlDiscoveryDescriptor,
): () => void {
  if (!isDescriptor(descriptor, stateDir))
    throw new Error("invalid AgentVoice discovery descriptor");
  const directory = discoveryDirectory(stateDir);
  assertPrivateDirectory(dirname(directory), false);
  assertPrivateDirectory(directory, true);
  const path = descriptorPath(stateDir, descriptor.instanceId);
  try {
    lstatSync(path);
    throw new Error(`AgentVoice discovery record already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(
    directory,
    `.${descriptor.instanceId}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.uid !== uid() || opened.nlink !== 1)
      throw new Error("unsafe temporary AgentVoice discovery record");
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(descriptor)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const published = assertPrivateFile(path);
    const owned: PublishedDescriptor = {
      path,
      device: Number(published.dev),
      inode: Number(published.ino),
    };
    return () => removePublishedDescriptor(owned);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function removePublishedDescriptor(owned: PublishedDescriptor): void {
  // The mode-0700 directory is the trust boundary. Legitimate controllers use
  // random instance IDs and therefore never replace one another's record path.
  try {
    const current = assertPrivateFile(owned.path);
    if (Number(current.dev) === owned.device && Number(current.ino) === owned.inode)
      unlinkSync(owned.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readDescriptors(stateDir: string): ControlDiscoveryDescriptor[] {
  const directory = discoveryDirectory(stateDir);
  try {
    assertPrivateDirectory(dirname(directory), false);
    assertPrivateDirectory(directory, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: string[] = [];
  const opened = opendirSync(directory);
  try {
    for (;;) {
      const entry = opened.readSync();
      if (!entry) break;
      if (names.length === MAX_RECORDS)
        throw new Error(`too many AgentVoice discovery entries (maximum ${MAX_RECORDS})`);
      names.push(entry.name);
    }
  } finally {
    opened.closeSync();
  }
  names.sort();
  const descriptors: ControlDiscoveryDescriptor[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    let info: Stats;
    try {
      info = assertPrivateFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.size > MAX_DESCRIPTOR_BYTES) continue;
    let content: string;
    try {
      content = readPrivateFile(path, info);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    if (!isDescriptor(parsed, stateDir)) continue;
    if (path !== descriptorPath(stateDir, parsed.instanceId)) continue;
    try {
      const socket = lstatSync(parsed.socketPath);
      if (
        !socket.isSocket() ||
        socket.isSymbolicLink() ||
        socket.uid !== uid() ||
        (socket.mode & 0o077) !== 0
      )
        throw new Error(`unsafe AgentVoice control socket: ${parsed.socketPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      process.kill(parsed.controllerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
    }
    descriptors.push(parsed);
  }
  return descriptors;
}

function statusFromSocket(
  descriptor: ControlDiscoveryDescriptor,
): Promise<ControlStatus | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket<{ text: string; decoder: TextDecoder }> | undefined;
    const finish = (status?: ControlStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.terminate();
      resolve(status);
    };
    const timer = setTimeout(() => finish(), PROBE_TIMEOUT_MS);
    void Bun.connect<{ text: string; decoder: TextDecoder }>({
      unix: descriptor.socketPath,
      socket: {
        open(peer) {
          if (settled) {
            peer.terminate();
            return;
          }
          socket = peer;
          peer.data = { text: "", decoder: new TextDecoder() };
          peer.write(
            `${JSON.stringify({
              v: CONTROL_PROTOCOL_VERSION,
              type: "request",
              id: "mcp-config",
              method: "agentvoice.status",
              params: {},
            })}\n`,
          );
        },
        data(peer, data) {
          peer.data.text += peer.data.decoder.decode(data, { stream: true });
          if (Buffer.byteLength(peer.data.text) > MAX_STATUS_BYTES) return finish();
          const newline = peer.data.text.indexOf("\n");
          if (newline < 0) return;
          try {
            const response = JSON.parse(peer.data.text.slice(0, newline)) as {
              ok?: unknown;
              result?: unknown;
            };
            if (response.ok !== true || !response.result || typeof response.result !== "object")
              return finish();
            const status = response.result as ControlStatus;
            if (
              status.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
              status.instanceId !== descriptor.instanceId ||
              typeof status.workspace !== "string" ||
              typeof status.threadId !== "string"
            )
              return finish();
            finish(status);
          } catch {
            finish();
          }
        },
        error() {
          finish();
        },
        close() {
          finish();
        },
      },
    }).catch(() => finish());
  });
}

export async function discoverController(
  stateDir: string,
  workspace: string,
  threadId?: string,
): Promise<{ descriptor: ControlDiscoveryDescriptor; status: ControlStatus }> {
  const descriptors = readDescriptors(stateDir);
  const statuses = await Promise.all(
    descriptors.map(async (descriptor) => ({
      descriptor,
      status: await statusFromSocket(descriptor),
    })),
  );
  const matches = statuses.filter(
    ({ status }) =>
      status?.workspace === workspace && (threadId === undefined || status.threadId === threadId),
  );
  if (matches.length === 0)
    throw new Error(
      threadId === undefined
        ? `no live AgentVoice controller found for workspace ${workspace}`
        : `no live AgentVoice controller found for workspace ${workspace} and thread ${threadId}`,
    );
  if (matches.length > 1)
    throw new Error(
      threadId === undefined
        ? `multiple live AgentVoice controllers found for workspace ${workspace}; pass --thread <id>`
        : `multiple live AgentVoice controllers found for workspace ${workspace} and thread ${threadId}`,
    );
  return matches[0]! as { descriptor: ControlDiscoveryDescriptor; status: ControlStatus };
}

export async function discoverMcpConnection(
  stateDir: string,
  workspace: string,
  threadId?: string,
): Promise<McpConnectionConfig> {
  const { descriptor } = await discoverController(stateDir, workspace, threadId);
  return {
    mcpServers: {
      agentvoice: {
        type: "http",
        url: descriptor.url,
        headers: { Authorization: `Bearer ${descriptor.token}` },
      },
    },
  };
}
