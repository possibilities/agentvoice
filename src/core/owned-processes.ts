/** Bounded ownership tracking for Unix descendants that may create new sessions. */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readdir, readFile } from "node:fs/promises";

const DEFAULT_POLL_MS = 50;
const MAX_CAPTURED_PROCESSES = 4_096;

interface ProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  birth: string;
}

export interface OwnedProcessOutcome {
  complete: boolean;
  survivors: number[];
  uncertain: number[];
}

export interface OwnedProcessTreeOptions {
  pollIntervalMs?: number;
  expectedParentPid?: number;
  debug?(line: string): void;
}

/**
 * Tracks only descendants observed under a specific kernel process identity.
 * A descendant that detaches and disappears between samples cannot be recovered.
 */
export class OwnedProcessTree {
  private readonly captured = new Map<number, ProcessRecord>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scan: Promise<void> | null = null;
  private followup: Promise<void> | null = null;
  private trackingFailure: Error | null = null;
  private stopped = false;
  private readonly expectedParentPid: number;

  constructor(
    private readonly rootPid: number,
    options: OwnedProcessTreeOptions = {},
  ) {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0)
      throw new Error(`Invalid owned process root PID: ${rootPid}`);
    this.expectedParentPid = options.expectedParentPid ?? process.pid;
    this.timer = setInterval(() => {
      if (!this.scan) void this.startScan().catch((error) => options.debug?.(String(error)));
    }, options.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  snapshotNow(): Promise<void> {
    if (this.stopped) return this.scan ?? Promise.resolve();
    if (!this.scan) return this.startScan();
    if (this.followup) return this.followup;
    const current = this.scan;
    const followup = current.catch(() => {}).then(() => this.performScan());
    this.followup = followup;
    this.scan = followup;
    const clear = () => {
      if (this.followup === followup) this.followup = null;
      if (this.scan === followup) this.scan = null;
    };
    void followup.then(clear, clear);
    return followup;
  }

  stopTracking(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  async signalCaptured(signal: NodeJS.Signals): Promise<OwnedProcessOutcome> {
    await this.snapshotNow();
    this.assertTrackingReliable();
    const table = await processTable();
    const active = this.activeCaptured(table);
    const own = table.get(process.pid);
    const safeGroups = new Set<number>();
    for (const record of active) {
      if (own && record.pid === record.pgid && record.pgid !== own.pgid)
        safeGroups.add(record.pgid);
    }
    for (const pgid of safeGroups) signalPid(-pgid, signal);
    for (const record of active) {
      if (!safeGroups.has(record.pgid)) signalPid(record.pid, signal);
    }
    return this.outcome();
  }

  async waitForCapturedExit(ms: number): Promise<OwnedProcessOutcome> {
    const end = Date.now() + Math.max(0, ms);
    let outcome = await this.outcome();
    while (!outcome.complete && Date.now() < end) {
      await Bun.sleep(Math.min(25, Math.max(1, end - Date.now())));
      await this.snapshotNow();
      outcome = await this.outcome();
    }
    return outcome;
  }

  private capture(record: ProcessRecord): void {
    const previous = this.captured.get(record.pid);
    if (previous && !sameIdentity(previous, record)) return;
    if (!previous && this.captured.size >= MAX_CAPTURED_PROCESSES)
      throw new Error(`Owned process tracking exceeded ${MAX_CAPTURED_PROCESSES} processes`);
    this.captured.set(record.pid, record);
  }

  private startScan(): Promise<void> {
    const scan = this.performScan();
    this.scan = scan;
    const clear = () => {
      if (this.scan === scan) this.scan = null;
    };
    void scan.then(clear, clear);
    return scan;
  }

  private async performScan(): Promise<void> {
    try {
      const table = await processTable();
      const root = table.get(this.rootPid);
      const capturedRoot = this.captured.get(this.rootPid);
      if (
        root &&
        ((!capturedRoot && root.ppid === this.expectedParentPid) ||
          (capturedRoot && sameIdentity(root, capturedRoot)))
      )
        this.capture(root);

      const owned = new Set<number>();
      for (const record of this.captured.values()) {
        const current = table.get(record.pid);
        if (current && sameIdentity(current, record)) owned.add(record.pid);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of table.values()) {
          if (owned.has(record.pid) || !owned.has(record.ppid)) continue;
          this.capture(record);
          owned.add(record.pid);
          changed = true;
        }
      }
      this.pruneExited(table);
    } catch (error) {
      this.trackingFailure ??= error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  private pruneExited(table: Map<number, ProcessRecord>): void {
    for (const record of this.captured.values()) {
      if (record.pid === this.rootPid) continue;
      const current = table.get(record.pid);
      if ((current && !sameIdentity(current, record)) || (!current && !pidExists(record.pid)))
        this.captured.delete(record.pid);
    }
  }

  private assertTrackingReliable(): void {
    if (this.trackingFailure)
      throw new Error(`Owned process tracking failed: ${this.trackingFailure.message}`);
  }

  private activeCaptured(table: Map<number, ProcessRecord>): ProcessRecord[] {
    const active: ProcessRecord[] = [];
    for (const record of this.captured.values()) {
      const current = table.get(record.pid);
      if (current && sameIdentity(current, record)) active.push(current);
    }
    return active;
  }

  private async outcome(): Promise<OwnedProcessOutcome> {
    this.assertTrackingReliable();
    const table = await processTable();
    const survivors: number[] = [];
    const uncertain: number[] = [];
    if (!this.captured.has(this.rootPid)) uncertain.push(this.rootPid);
    for (const record of this.captured.values()) {
      const current = table.get(record.pid);
      if (current) {
        if (sameIdentity(current, record)) survivors.push(record.pid);
        continue;
      }
      if (pidExists(record.pid)) uncertain.push(record.pid);
    }
    return {
      complete: survivors.length === 0 && uncertain.length === 0,
      survivors,
      uncertain,
    };
  }
}

function sameIdentity(a: ProcessRecord, b: ProcessRecord): boolean {
  return a.pid === b.pid && a.birth === b.birth;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function processTableBackendForPlatform(platform: string): "proc" | "libproc" {
  if (platform === "linux" || platform === "android") return "proc";
  if (platform === "darwin") return "libproc";
  throw new Error(`Owned process tracking is unsupported on ${platform}`);
}

async function processTable(): Promise<Map<number, ProcessRecord>> {
  return processTableBackendForPlatform(process.platform) === "proc"
    ? linuxProcessTable()
    : darwinProcessTable();
}

async function linuxProcessTable(): Promise<Map<number, ProcessRecord>> {
  const table = new Map<number, ProcessRecord>();
  const entries = await readdir("/proc", { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return;
      try {
        const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
        const end = stat.lastIndexOf(") ");
        if (end < 0) return;
        const pid = Number(stat.slice(0, stat.indexOf(" ")));
        const fields = stat.slice(end + 2).split(" ");
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        const birth = fields[19];
        if (
          Number.isSafeInteger(pid) &&
          Number.isSafeInteger(ppid) &&
          Number.isSafeInteger(pgid) &&
          birth
        )
          table.set(pid, { pid, ppid, pgid, birth });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") throw error;
      }
    }),
  );
  return table;
}

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
let libproc: ReturnType<typeof openLibproc> | undefined;

function openLibproc() {
  return dlopen("/usr/lib/libproc.dylib", {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
}

async function darwinProcessTable(): Promise<Map<number, ProcessRecord>> {
  libproc ??= openLibproc();
  const count = libproc.symbols.proc_listallpids(null, 0);
  if (count <= 0) throw new Error("Could not enumerate owned processes");
  const pids = Buffer.alloc((count + 64) * 4);
  const found = libproc.symbols.proc_listallpids(ptr(pids), pids.length);
  if (found <= 0) throw new Error("Could not enumerate owned processes");
  const table = new Map<number, ProcessRecord>();
  for (let index = 0; index < Math.min(found, pids.length / 4); index++) {
    const pid = pids.readInt32LE(index * 4);
    if (pid <= 0) continue;
    const info = Buffer.allocUnsafe(PROC_BSDINFO_SIZE);
    const bytes = libproc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), info.length);
    if (bytes !== PROC_BSDINFO_SIZE) continue;
    const reportedPid = info.readUInt32LE(12);
    if (reportedPid !== pid) continue;
    table.set(pid, {
      pid,
      ppid: info.readUInt32LE(16),
      pgid: info.readUInt32LE(100),
      birth: `${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}`,
    });
  }
  return table;
}
