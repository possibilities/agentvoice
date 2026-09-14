import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { safeAncestors } from "../private-files.ts";
import { batchSchema, type Mutation, mutationSchema } from "./contract.ts";
import type { Assignment, Result, Work, WorkEvent, WorkSnapshot } from "./types.ts";

type Entity = Work | Assignment | Result;
type Kind = "work" | "assignment" | "result";
export class WorkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function hudDatabasePath(env = process.env, home = homedir()): string {
  const xdg = env["XDG_STATE_HOME"];
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"),
    "agenthud",
    "work.sqlite3",
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function demand(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new WorkError(code, message);
}
/** One local OS-user trust domain. Actor strings are declarations, not native authentication. */
export class WorkStore {
  private db: Database;
  constructor(readonly path = hudDatabasePath()) {
    const directory = dirname(path);
    safeAncestors(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    demand(
      dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid?.(),
      "unsafe_path",
      "Work directory must be owned by the current user and not a symlink",
    );
    chmodSync(directory, 0o700);
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        const info = lstatSync(candidate);
        demand(
          info.isFile() &&
            info.nlink === 1 &&
            !info.isSymbolicLink() &&
            info.uid === process.getuid?.(),
          "unsafe_path",
          "Work database files must be regular files owned by the current user",
        );
        chmodSync(candidate, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    const version =
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > 1) {
      this.db.close();
      throw new WorkError("schema_version", "Work database was created by a newer agenthud");
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operationId TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entityId TEXT NOT NULL, at TEXT NOT NULL);
      PRAGMA user_version=1;`);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  close(): void {
    this.db.close();
  }
  get<T extends Entity = Entity>(kind: Kind, id: string): T {
    const row = this.db
      .query<{ body: string }, [string, string]>("SELECT body FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    demand(row, "not_found", `${kind} ${id} does not exist`);
    return JSON.parse(row.body) as T;
  }
  private list<T extends Entity>(kind: Kind): T[] {
    return this.db
      .query<{ body: string }, [string]>("SELECT body FROM records WHERE kind=? ORDER BY id")
      .all(kind)
      .map((row) => JSON.parse(row.body) as T);
  }
  snapshot(): WorkSnapshot {
    return this.db.transaction(() => ({
      revision:
        this.db
          .query<{ revision: number }, []>(
            "SELECT coalesce(max(sequence),0) AS revision FROM events",
          )
          .get()?.revision ?? 0,
      works: this.list<Work>("work"),
      assignments: this.list<Assignment>("assignment"),
      results: this.list<Result>("result"),
      events: this.db
        .query<WorkEvent, []>("SELECT * FROM events ORDER BY sequence DESC LIMIT 100")
        .all()
        .reverse(),
    }))();
  }
  mutate(input: unknown): Entity {
    const operation = mutationSchema.parse(input);
    return this.db.transaction(() => this.apply(operation)).immediate();
  }
  batch(input: unknown): Entity[] {
    const batch = batchSchema.parse(input);
    return this.db
      .transaction(() => {
        const payload = canonical(batch);
        const prior = this.db
          .query<{ payload: string; response: string }, [string]>(
            "SELECT payload,response FROM operations WHERE id=?",
          )
          .get(batch.operationId);
        if (prior) {
          demand(
            prior.payload === payload,
            "operation_conflict",
            "Batch operation ID was already used with a different payload",
          );
          return JSON.parse(prior.response) as Entity[];
        }
        demand(
          !batch.operations.some((op) => op.operationId === batch.operationId),
          "operation_conflict",
          "Batch and mutation IDs must differ",
        );
        const results = batch.operations.map((op) => this.apply(op));
        this.db
          .query("INSERT INTO operations(id,payload,response) VALUES(?,?,?)")
          .run(batch.operationId, payload, JSON.stringify(results));
        return results;
      })
      .immediate();
  }
  private apply(op: Mutation): Entity {
    const payload = canonical(op);
    const prior = this.db
      .query<{ payload: string; response: string }, [string]>(
        "SELECT payload,response FROM operations WHERE id=?",
      )
      .get(op.operationId);
    if (prior) {
      demand(
        prior.payload === payload,
        "operation_conflict",
        "Operation ID was already used with a different payload",
      );
      return JSON.parse(prior.response) as Entity;
    }
    const kind = op.action.split(".")[0] as Kind;
    const create = ["work.create", "assignment.prepare", "result.record"].includes(op.action);
    const row = this.db
      .query<{ revision: number }, [string]>("SELECT revision FROM records WHERE id=?")
      .get(op.id);
    demand(
      create ? !row && op.expectedRevision === 0 : row?.revision === op.expectedRevision,
      "revision_conflict",
      "Expected revision does not match; read the current record before deciding a new mutation",
    );
    const now = new Date().toISOString();
    const base = { id: op.id, revision: op.expectedRevision + 1, createdAt: now, updatedAt: now };
    let entity: Entity;
    switch (op.action) {
      case "work.create": {
        demand(
          op.actor === op.data.lead,
          "owner_conflict",
          "The declared lead must create its own Work",
        );
        entity = { ...base, ...op.data, scopeRevision: 1 };
        this.validateWork(entity);
        break;
      }
      case "work.update": {
        const work = this.get<Work>("work", op.id);
        demand(
          work.lead === op.actor,
          "owner_conflict",
          "Only the declared Work lead may update Work",
        );
        const semanticChange = (
          ["objective", "scope", "authority", "lead", "parentId", "dependencies"] as const
        ).some(
          (key) => op.data[key] !== undefined && canonical(op.data[key]) !== canonical(work[key]),
        );
        const reopening =
          op.data.disposition !== undefined &&
          !["completed", "cancelled"].includes(op.data.disposition);
        demand(
          !["completed", "cancelled"].includes(work.disposition) || !semanticChange || reopening,
          "closed_work",
          "Explicitly reopen Work in the same mutation before changing its objective, authority, ownership or obligations",
        );
        entity = {
          ...work,
          ...op.data,
          scopeRevision: (work.scopeRevision ?? 1) + (semanticChange ? 1 : 0),
          revision: base.revision,
          updatedAt: now,
        };
        this.validateWork(entity);
        break;
      }
      case "assignment.prepare": {
        const work = this.get<Work>("work", op.data.workId);
        demand(
          !["completed", "cancelled"].includes(work.disposition),
          "closed_work",
          "Reopen Work before preparing a new assignment",
        );
        this.validateAncestors(work);
        let allowed = op.actor === work.lead;
        if (op.data.parentAssignmentId) {
          const parent = this.get<Assignment>("assignment", op.data.parentAssignmentId);
          demand(
            parent.workId === work.id,
            "invalid_parent",
            "Parent assignment belongs to different Work",
          );
          allowed ||= parent.assignee === op.actor;
        }
        demand(
          allowed,
          "owner_conflict",
          "Only the lead or declared parent assignee may issue this assignment",
        );
        entity = {
          ...base,
          ...op.data,
          scopeRevision: work.scopeRevision ?? 1,
          issuer: op.actor,
          binding: null,
        };
        break;
      }
      case "assignment.bind": {
        const assignment = this.get<Assignment>("assignment", op.id);
        demand(
          assignment.issuer === op.actor,
          "owner_conflict",
          "Only the declared issuing parent may bind dispatch evidence",
        );
        demand(
          !this.list<Result>("result").some(
            (result) => result.assignmentId === assignment.id && result.dispatchResolution,
          ),
          "dispatch_resolved",
          "Dispatch was resolved without execution; prepare a new assignment",
        );
        demand(
          !assignment.binding,
          "already_bound",
          "A bound assignment is immutable; prepare a successor for a reused thread",
        );
        for (const other of this.list<Assignment>("assignment")) {
          const binding = other.binding;
          demand(
            !binding ||
              binding.instanceId !== op.data.instanceId ||
              binding.generation !== op.data.generation ||
              binding.threadId !== op.data.threadId ||
              binding.turnId !== op.data.turnId,
            "binding_conflict",
            "This exact native turn already belongs to an assignment",
          );
        }
        entity = { ...assignment, binding: op.data, revision: base.revision, updatedAt: now };
        break;
      }
      case "result.record": {
        const work = this.get<Work>("work", op.data.workId);
        demand(
          !["completed", "cancelled"].includes(work.disposition),
          "closed_work",
          "Reopen Work before recording another result",
        );
        demand(
          !op.data.dispatchResolution || op.data.assignmentId,
          "invalid_assignment",
          "Dispatch resolution requires an assignment",
        );
        let allowed = work.lead === op.actor;
        let resultScopeRevision = work.scopeRevision ?? 1;
        if (op.data.assignmentId) {
          const assignment = this.get<Assignment>("assignment", op.data.assignmentId);
          resultScopeRevision = assignment.scopeRevision ?? 1;
          demand(
            assignment.workId === work.id,
            "invalid_assignment",
            "Assignment belongs to different Work",
          );
          allowed ||= assignment.assignee === op.actor || assignment.issuer === op.actor;
          if (!assignment.binding && !op.data.binding && op.data.dispatchResolution) {
            demand(
              !this.list<Result>("result").some(
                (result) => result.assignmentId === assignment.id && result.dispatchResolution,
              ),
              "dispatch_resolved",
              "Dispatch already has a no-execution resolution; retry its original operation instead",
            );
            demand(
              ["failed", "interrupted"].includes(op.data.outcome),
              "invalid_resolution",
              "No-execution dispatch resolution must be failed or interrupted, with evidence",
            );
          } else {
            demand(
              !op.data.dispatchResolution &&
                assignment.binding &&
                op.data.binding &&
                sameBinding(assignment.binding, op.data.binding),
              "binding_conflict",
              "Assignment results need its exact bound native instance, generation, root, thread and turn",
            );
          }
        }
        demand(
          allowed,
          "owner_conflict",
          "Only the lead or declared assignee/issuer may record this result",
        );
        entity = {
          ...base,
          ...op.data,
          scopeRevision: resultScopeRevision,
          actor: op.actor,
          reviews: [],
          presentations: [],
        };
        break;
      }
      case "result.review": {
        const result = this.get<Result>("result", op.id);
        const work = this.get<Work>("work", result.workId);
        demand(
          !["completed", "cancelled"].includes(work.disposition),
          "closed_work",
          "Reopen Work before changing result review",
        );
        demand(
          !result.presentations.length,
          "already_presented",
          "Presented evidence is immutable; record a successor result for further review",
        );
        const issuer = result.assignmentId
          ? this.get<Assignment>("assignment", result.assignmentId).issuer
          : null;
        demand(
          work.lead === op.actor || issuer === op.actor,
          "owner_conflict",
          "Only the declared Work lead or issuing parent may review results",
        );
        entity = {
          ...result,
          revision: base.revision,
          updatedAt: now,
          reviews: [...result.reviews, { actor: op.actor, ...op.data, at: now }],
        };
        break;
      }
      case "result.present": {
        const result = this.get<Result>("result", op.id);
        demand(
          this.get<Work>("work", result.workId).lead === op.actor,
          "owner_conflict",
          "Only the declared Work lead may record human presentation",
        );
        demand(
          result.reviews.at(-1)?.decision === "accepted",
          "review_required",
          "Accept the result before recording presentation",
        );
        entity = {
          ...result,
          revision: base.revision,
          updatedAt: now,
          presentations: [...result.presentations, { actor: op.actor, ...op.data, at: now }],
        };
        break;
      }
    }
    const response = JSON.stringify(entity);
    this.db
      .query(
        "INSERT INTO records(kind,id,revision,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body",
      )
      .run(kind, op.id, entity.revision, response);
    this.db
      .query("INSERT INTO operations(id,payload,response) VALUES(?,?,?)")
      .run(op.operationId, payload, response);
    this.db
      .query("INSERT INTO events(operationId,actor,action,entityId,at) VALUES(?,?,?,?,?)")
      .run(op.operationId, op.actor, op.action, op.id, now);
    return entity;
  }
  private validateAncestors(work: Work): void {
    const seen = new Set([work.id]);
    let parent = work.parentId;
    while (parent) {
      demand(!seen.has(parent), "invalid_parent", "Work containment cannot contain cycles");
      seen.add(parent);
      const ancestor = this.get<Work>("work", parent);
      demand(
        ["completed", "cancelled"].includes(work.disposition) ||
          !["completed", "cancelled"].includes(ancestor.disposition),
        "closed_parent",
        "Reopen parent Work before adding or reopening a child",
      );
      parent = ancestor.parentId;
    }
  }
  private validateWork(work: Work): void {
    this.validateAncestors(work);
    if (["completed", "cancelled"].includes(work.disposition)) {
      const works = this.list<Work>("work");
      const pending = [work.id];
      const visited = new Set<string>();
      for (let index = 0; index < pending.length; index++) {
        const parentId = pending[index];
        if (!parentId || visited.has(parentId)) continue;
        visited.add(parentId);
        for (const child of works.filter((item) => item.parentId === parentId)) {
          demand(
            ["completed", "cancelled"].includes(child.disposition),
            "child_open",
            "Child Work remains outstanding; close it before closing the parent",
          );
          pending.push(child.id);
        }
      }
    }
    const visit = (current: Work, path: Set<string>): void => {
      demand(
        !path.has(current.id),
        "invalid_dependency",
        "Work dependencies cannot contain cycles",
      );
      const next = new Set([...path, current.id]);
      for (const dependency of current.dependencies)
        visit(dependency === work.id ? work : this.get<Work>("work", dependency), next);
    };
    visit(work, new Set());
    if (work.disposition === "completed") {
      const results = this.list<Result>("result").filter((result) => result.workId === work.id);
      demand(
        results.length && results.every((result) => result.reviews.at(-1)?.decision === "accepted"),
        "review_required",
        "Completion requires accepted result evidence; pending presentation remains separately visible",
      );
      demand(
        results.some(
          (result) =>
            result.outcome === "completed" &&
            (result.scopeRevision ?? 1) === (work.scopeRevision ?? 1),
        ),
        "result_required",
        "Completion requires a completed result recorded for the current scope revision",
      );
      for (const dependency of work.dependencies)
        demand(
          this.get<Work>("work", dependency).disposition === "completed",
          "dependency_open",
          "Dependencies must be completed first",
        );

      for (const assignment of this.list<Assignment>("assignment").filter(
        (item) => item.workId === work.id,
      ))
        demand(
          results.some((result) => result.assignmentId === assignment.id),
          "result_required",
          "Every assignment requires returned evidence before completing Work",
        );
    }
  }
}
export function sameBinding(
  a: NonNullable<Assignment["binding"]>,
  b: NonNullable<Assignment["binding"]>,
): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.generation === b.generation &&
    a.rootThreadId === b.rootThreadId &&
    a.threadId === b.threadId &&
    a.turnId === b.turnId
  );
}
