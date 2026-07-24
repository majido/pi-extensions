import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ScheduleJob = {
  id?: string;
  name?: string;
  [key: string]: unknown;
};

type ScheduleStore = {
  jobs?: ScheduleJob[];
  version?: number;
  [key: string]: unknown;
};

/** Best-effort cancellation fallback for jobs owned by a deleted/finished run. */
export function cancelScheduledJob(cwd: string, jobId?: string, jobName?: string): boolean {
  if (!jobId && !jobName) return false;
  const path = join(cwd, ".pi", "schedule-prompts.json");
  if (!existsSync(path)) return false;

  let store: ScheduleStore;
  try {
    store = JSON.parse(readFileSync(path, "utf-8")) as ScheduleStore;
  } catch {
    return false;
  }
  if (!Array.isArray(store.jobs)) return false;

  const jobs = store.jobs.filter((job) => {
    const idMatches = jobId !== undefined && job.id === jobId;
    const nameMatches = jobName !== undefined && job.name === jobName;
    return !(idMatches || nameMatches);
  });
  if (jobs.length === store.jobs.length) return false;

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ ...store, jobs }, null, 2));
  renameSync(tmp, path);
  return true;
}
