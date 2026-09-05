/** Bounded controller-lifetime operation journal, fsynced before acceptance/teardown. */
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ControlOperation } from "../control/types.ts";

export class OperationJournal {
  private readonly records = new Map<string, ControlOperation>();
  private readonly fd: number;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    // Persist creation as well as subsequent records before any accepted response.
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  get(id: string) {
    return this.records.get(id);
  }
  all() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
  save(operation: ControlOperation): void {
    if (!this.records.has(operation.operationId) && this.records.size >= 256)
      throw new Error(
        "Controller operation limit reached; quit and relaunch before further mutations",
      );
    const bytes = Buffer.from(`${JSON.stringify(operation)}\n`);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
    fsyncSync(this.fd);
    this.records.set(operation.operationId, structuredClone(operation));
  }
  close() {
    closeSync(this.fd);
  }
}
