/**
 * ship state — worktree-local state files under <cwd>/.pi/ship/.
 *
 * Layout:
 *   <cwd>/.pi/ship/current.json     → { runId } pointer (absent = no active run)
 *   <cwd>/.pi/ship/<runId>/state.json
 *   <cwd>/.pi/ship/<runId>/journal.md
 *   <cwd>/.pi/ship/<runId>/<stage>.md
 *
 * The extension is a renderer; the ship executor (subagent) is the writer.
 * Writes here (from the extension) are limited to bootstrap, steering
 * instructions, and status transitions the executor cannot make (abort).
 * All writes are atomic (temp + rename) so the fs-watcher never sees a
 * half-written file.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type StageStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export type RunStatus =
  | "running"
  | "paused"
  | "waiting-ci"
  | "done"
  | "failed"
  | "aborted";

export type Phase = "pipeline" | "ci" | "done";

export interface StageState {
  id: string;
  status: StageStatus;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  /** One-liner: present tense while running, past tense when done. */
  note?: string;
  artifact?: string;
}

export interface Decision {
  stage: string;
  what: string;
  tradeoff?: string;
  suggestion?: string;
}

export interface ShipState {
  runId: string;
  cwd: string;
  parentSessionFile?: string;
  phase: Phase;
  currentRun?: {
    asyncId?: string;
    asyncDir?: string;
    spawnedBySessionId?: string;
  };
  stage?: string;
  status: RunStatus;
  stages: StageState[];
  needsDecision: Decision[];
  /** User steering for the NEXT spawn; consumed on read by the executor. */
  instructions: string[];
  pr?: { repo?: string; number?: number; url?: string };
  ci?: {
    intervalMin?: number;
    nextCheckAt?: string | null;
    checkConclusions?: Record<string, string>;
    cycles?: number;
  };
  seenCommentIds?: string[];
  seenReviewIds?: string[];
  startedAt: string;
  title?: string;
}

export const DEFAULT_STAGES: string[] = [
  "review",
  "test",
  "docs",
  "lint",
  "push",
  "pr",
  "ci",
  "comments",
];

export function shipDir(cwd: string): string {
  return join(cwd, ".pi", "ship");
}

export function currentPointerPath(cwd: string): string {
  return join(shipDir(cwd), "current.json");
}

export function runDir(cwd: string, runId: string): string {
  return join(shipDir(cwd), runId);
}

export function statePath(cwd: string, runId: string): string {
  return join(runDir(cwd, runId), "state.json");
}

export function journalPath(cwd: string, runId: string): string {
  return join(runDir(cwd, runId), "journal.md");
}

function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function readCurrentRunId(cwd: string): string | undefined {
  const p = currentPointerPath(cwd);
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as { runId?: string };
    return parsed.runId;
  } catch {
    return undefined;
  }
}

export function readState(cwd: string, runId: string): ShipState | undefined {
  const p = statePath(cwd, runId);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ShipState;
  } catch {
    // Half-written or corrupt; caller treats as "no readable state this tick".
    return undefined;
  }
}

/** Read the active run's state for a worktree, if any. */
export function readActiveState(cwd: string): ShipState | undefined {
  const runId = readCurrentRunId(cwd);
  if (!runId) return undefined;
  return readState(cwd, runId);
}

export function writeState(state: ShipState): void {
  const dir = runDir(state.cwd, state.runId);
  mkdirSync(dir, { recursive: true });
  atomicWrite(statePath(state.cwd, state.runId), JSON.stringify(state, null, 2));
}

export function setCurrentPointer(cwd: string, runId: string | undefined): void {
  mkdirSync(shipDir(cwd), { recursive: true });
  const p = currentPointerPath(cwd);
  atomicWrite(p, JSON.stringify({ runId: runId ?? null }, null, 2));
}

export function appendJournal(cwd: string, runId: string, line: string): void {
  const dir = runDir(cwd, runId);
  mkdirSync(dir, { recursive: true });
  const p = journalPath(cwd, runId);
  const stamp = new Date().toISOString();
  const existing = existsSync(p) ? readFileSync(p, "utf-8") : "";
  writeFileSync(p, `${existing}\n### ${stamp}\n${line}\n`);
}

export interface NewRunOptions {
  cwd: string;
  stages: string[];
  parentSessionFile?: string;
  title?: string;
}

/** Create a fresh run: state dir, initial state.json, current.json pointer. */
export function createRun(opts: NewRunOptions): ShipState {
  const runId = makeRunId(opts.title);
  const state: ShipState = {
    runId,
    cwd: opts.cwd,
    parentSessionFile: opts.parentSessionFile,
    phase: "pipeline",
    status: "running",
    stages: opts.stages.map((id) => ({ id, status: "pending" })),
    needsDecision: [],
    instructions: [],
    startedAt: new Date().toISOString(),
    title: opts.title,
  };
  writeState(state);
  setCurrentPointer(opts.cwd, runId);
  return state;
}

function makeRunId(title?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = (title ?? "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-${slug || "run"}-${rand}`;
}
