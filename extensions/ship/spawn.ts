/**
 * ship spawn — launch the ship executor as a detached async subagent via the
 * pi-subagents in-process RPC event bus (documented v1 contract). We capture
 * the asyncId from the reply so the extension can steer/inspect the live run.
 *
 * The executor loads the `ship` skill and is the single writer in the worktree.
 * Context defaults to "fresh": forking the parent session mid-turn is fragile
 * (persistence/leaf conditions, thinking-block stripping) and the executor
 * reconstructs everything it needs from the git diff + skill, so fresh is the
 * robust default. `context: "fork"` remains available for callers that want it.
 */

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

type EventsLike = {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
};

export interface SpawnPipelineParams {
  cwd: string;
  runId: string;
  stateDir: string;
  stages: string[];
  /** User steering / kickoff notes to seed the first run. */
  instructions?: string[];
  /** Defaults to "fresh" (robust). "fork" is opt-in and can fail mid-turn. */
  context?: "fork" | "fresh";
}

export interface SpawnResult {
  asyncId?: string;
  asyncDir?: string;
  error?: string;
  rawText?: string;
}

function buildTask(p: SpawnPipelineParams): string {
  const scope = p.stages.join(" → ");
  const steer = p.instructions?.length
    ? `\n\nUser instructions to honor:\n${p.instructions.map((s) => `- ${s}`).join("\n")}`
    : "";
  return [
    `Run the ship pipeline. Load the \`ship\` skill and follow it.`,
    ``,
    `runId: ${p.runId}`,
    `state dir: ${p.stateDir}`,
    `stages this run: ${scope}`,
    ``,
    `Maintain ${p.stateDir}/state.json (atomically) and append`,
    `${p.stateDir}/journal.md as you go. Update each stage's status and a`,
    `short present/past-tense note so the user's view stays accurate.`,
    `Escalate design-level or ambiguous items to needsDecision and stop them.`,
    steer,
  ].join("\n");
}

function parseAsyncId(text: string): string | undefined {
  // Fallback only. Async spawn message looks like: "Async: ship [<uuid>]"
  const m = text.match(/\[([0-9a-f]{8}-[0-9a-f-]{20,})\]/i);
  return m?.[1];
}

/**
 * Emit the spawn request and resolve with the asyncId once the reply arrives.
 * Times out after `timeoutMs` (spawn is fast; this only guards a missing bus).
 */
export function spawnPipeline(
  events: EventsLike,
  params: SpawnPipelineParams,
  timeoutMs = 15_000,
): Promise<SpawnResult> {
  const requestId = `ship-${params.runId}-${Date.now()}`;
  const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;

  return new Promise<SpawnResult>((resolve) => {
    let settled = false;
    let unsub: (() => void) | void;

    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      if (typeof unsub === "function") unsub();
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ error: "spawn RPC timed out (is pi-subagents loaded?)" }),
      timeoutMs,
    );
    (timer as { unref?: () => void }).unref?.();

    unsub = events.on(replyEvent, (raw) => {
      const reply = raw as {
        success?: boolean;
        data?: { text?: string; isError?: boolean };
        error?: { message?: string };
      };
      if (reply.success === false) {
        finish({ error: reply.error?.message ?? "spawn failed" });
        return;
      }
      // Prefer structured details ({ asyncId, asyncDir }); fall back to text.
      const details = (reply.data as { details?: { asyncId?: string; asyncDir?: string } })?.details;
      const text = reply.data?.text ?? "";
      finish({
        asyncId: details?.asyncId ?? parseAsyncId(text),
        asyncDir: details?.asyncDir,
        rawText: text,
      });
    });

    events.emit(RPC_REQUEST_EVENT, {
      version: 1,
      requestId,
      method: "spawn",
      params: {
        agent: "ship",
        task: buildTask(params),
        context: params.context ?? "fresh",
        async: true,
        cwd: params.cwd,
      },
    });
  });
}

// Steering note: `steer` is not a v1 RPC method (only ping/status/spawn/
// interrupt/stop are). Live steering of a running child is only reachable
// through the LLM `subagent({ action: "steer" })` tool, which is same-session
// bound anyway. In v1 the extension routes all steering through the run's
// state.json `instructions[]`, which the executor reads at the start of every
// spawn — robust across the fresh-run-per-cycle model without depending on a
// live handle.

/** Interrupt a live run via the RPC bus (used by /ship-abort). */
export function interruptRun(events: EventsLike, asyncId: string): void {
  events.emit(RPC_REQUEST_EVENT, {
    version: 1,
    requestId: `ship-interrupt-${asyncId}-${Date.now()}`,
    method: "interrupt",
    params: { id: asyncId },
  });
}
