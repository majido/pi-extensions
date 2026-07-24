import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readRuntimeState, readState, type ShipState } from "./state.ts";
import { cancelScheduledJob } from "./schedule-store.ts";
import { interruptRun } from "./spawn.ts";

type EventsLike = { emit(event: string, data: unknown): void };

export interface ShipIndexEntry {
  runId: string;
  cwd: string;
  startedAt: string;
  scheduleJobId?: string;
  scheduleJobName?: string;
  asyncId?: string;
  asyncDir?: string;
}

export interface FleetEntry extends ShipIndexEntry {
  state?: ShipState;
  orphaned?: boolean;
}

interface ShipIndex {
  version: 1;
  runs: ShipIndexEntry[];
}

function indexPath(): string {
  return process.env.PI_SHIP_INDEX_PATH ?? join(homedir(), ".pi", "agent", "ship", "index.json");
}

function readIndex(): ShipIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(), "utf-8")) as Partial<ShipIndex>;
    if (!Array.isArray(parsed.runs)) return { version: 1, runs: [] };
    return {
      version: 1,
      runs: parsed.runs.filter(isIndexEntry),
    };
  } catch {
    return { version: 1, runs: [] };
  }
}

function isIndexEntry(value: unknown): value is ShipIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ShipIndexEntry>;
  return typeof entry.runId === "string" && typeof entry.cwd === "string" && typeof entry.startedAt === "string";
}

function writeIndex(index: ShipIndex): void {
  const path = indexPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, path);
}

function withIndexLock<T>(fn: () => T): T {
  const lock = `${indexPath()}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      mkdirSync(lock);
      acquired = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // The owner may have released the lock between stat and cleanup.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (!acquired) return fn();
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function registerRun(state: ShipState): void {
  withIndexLock(() => {
    const index = readIndex();
    const next = index.runs.filter((entry) => !(entry.cwd === state.cwd && entry.runId === state.runId));
    next.push({
      runId: state.runId,
      cwd: state.cwd,
      startedAt: state.startedAt,
      scheduleJobId: state.ci?.scheduleJobId,
      scheduleJobName: state.ci?.scheduleJobName,
      asyncId: state.currentRun?.asyncId,
      asyncDir: state.currentRun?.asyncDir,
    });
    writeIndex({ version: 1, runs: next });
  });
}

export function removeRun(runId: string, cwd?: string): void {
  withIndexLock(() => {
    const index = readIndex();
    const next = index.runs.filter((entry) => entry.runId !== runId || (cwd !== undefined && entry.cwd !== cwd));
    if (next.length !== index.runs.length) writeIndex({ version: 1, runs: next });
  });
}

function isTerminal(state: ShipState | undefined): boolean {
  return state?.status === "done" || state?.status === "failed" || state?.status === "aborted";
}

/**
 * Remove finished or unreadable runs from the fleet index. If a run still has
 * a scheduled monitor, remove that job as a best-effort orphan cleanup.
 */
export function sweepIndex(events?: EventsLike): { entries: FleetEntry[]; removed: number } {
  return withIndexLock(() => {
    const index = readIndex();
    const entries: FleetEntry[] = [];
    let removed = 0;

    for (const entry of index.runs) {
      const state = readState(entry.cwd, entry.runId);
      const missingWorktree = !existsSync(entry.cwd);
      if (missingWorktree || !state || isTerminal(state)) {
        const asyncId = state?.currentRun?.asyncId ?? entry.asyncId;
        const asyncDir = state?.currentRun?.asyncDir ?? entry.asyncDir;
        if ((missingWorktree || !state) && asyncId && readRuntimeState(asyncDir) === "running") {
          if (events) interruptRun(events, asyncId);
        }
        cancelScheduledJob(
          entry.cwd,
          state?.ci?.scheduleJobId ?? entry.scheduleJobId,
          state?.ci?.scheduleJobName ?? entry.scheduleJobName,
        );
        removed++;
        continue;
      }
      entries.push({ ...entry, state });
    }

    if (removed > 0) writeIndex({ version: 1, runs: entries });
    return { entries, removed };
  });
}

export function listFleet(events?: EventsLike): FleetEntry[] {
  return sweepIndex(events).entries;
}

