import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BridgeDecision } from "./bridge";

/**
 * Outcome feedback: did Jev's pick actually finish the job?
 *
 * Jev recorded a *decision* (which model, why, confidence) but never an
 * *outcome*, so the picker optimised for capacity when the number the user
 * actually pays for is **cost per solved task**. A weak model that burns four
 * attempts — or never lands — is more expensive than a strong one that finishes
 * in one, even at a much higher per-token price.
 *
 * The data already exists: OpenCode's `session_v2` stores per session
 *   idle_outcome  - succeeded / failed / interrupted (measured on this host)
 *   time_idle     - completion timestamp, so duration is derivable
 *   tokens_*      - what the task actually burned
 *   cost          - what it actually cost
 * Jev already reads this table to measure plan usage; it never read it back to
 * measure its own decision quality. That is what this closes.
 *
 * Measured column vocabulary on this host (136 child sessions):
 *   idle_outcome   : succeeded 104, failed 16, interrupted 6, null 10
 *   resume_attempts: 0 for every row - NOT a usable signal here
 *   cost           : 0.0 everywhere (free tiers)
 * So the usable failure signals are `idle_outcome` itself and the tokens a
 * failed task burned. `resume_attempts` is read but not relied upon.
 *
 * Fail-soft everywhere: a missing/locked DB yields no outcomes and the picker
 * behaves exactly as it did before.
 */

type Db = {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};

/** One delegated task's measured result. */
export type TaskOutcome = {
  sessionID: string;
  lane: string;
  model: string;
  outcome: "succeeded" | "failed" | "interrupted" | "unknown";
  /** Not populated by this host (always 0) — read but not relied on. */
  resumeAttempts: number;
  /** time_idle - time_created. Long *and* failed is the strongest "it flailed". */
  durationMs: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  costUsd: number;
  ts: number;
};

/** Per-model rollup over the tasks Jev routed there. */
export type ModelQuality = {
  ref: string;
  attempts: number;
  solved: number;
  failed: number;
  interrupted: number;
  unknown: number;
  /**
   * Tokens burned on tasks that did NOT succeed, per attempt. The real "was the
   * model up to it" signal: a failed session that burned 4M cache-read tokens is
   * stronger evidence than any resume count.
   */
  wastedTokensPerAttempt: number;
  /** Tokens burned per *solved* task. Infinity when nothing solved. */
  tokensPerSolved: number;
  costPerSolvedUsd: number;
  /** solved / attempts — the number that actually matters. */
  solvedRate: number;
  /** Median wall-clock per task, seconds. */
  medianSeconds: number;
};

/** Read every child session's measured result from `session_v2`. */
export async function readTaskOutcomes(
  dbPath: string = outcomesDbPath(),
): Promise<TaskOutcome[]> {
  if (!dbPath || !existsSync(dbPath)) return [];
  const db = await openDatabase(dbPath);
  if (!db) return [];

  try {
    const rows = db
      .prepare(
        `select id, agent, model, idle_outcome, resume_attempts,
                tokens_input, tokens_output, tokens_cache_read, cost,
                time_created, time_idle
           from session_v2
          where parent_id is not null
          order by time_created desc
          limit 2000`,
      )
      .all() as any[];

    const out: TaskOutcome[] = [];
    for (const r of rows ?? []) {
      let model = String(r?.model ?? "");
      // session_v2.model is JSON: {"providerID":..,"id":..,"variant":..}
      try {
        const parsed = JSON.parse(model);
        if (parsed && typeof parsed === "object") {
          model = `${parsed.providerID}/${parsed.id}`;
        }
      } catch {
        // not JSON — use it verbatim
      }
      const created = Number(r?.time_created ?? 0) || 0;
      const idle = Number(r?.time_idle ?? 0) || 0;
      out.push({
        sessionID: String(r?.id ?? ""),
        lane: String(r?.agent ?? ""),
        model,
        outcome: normaliseOutcome(r?.idle_outcome),
        resumeAttempts: Number(r?.resume_attempts ?? 0) || 0,
        durationMs: created > 0 && idle > created ? idle - created : 0,
        tokensInput: Number(r?.tokens_input ?? 0) || 0,
        tokensOutput: Number(r?.tokens_output ?? 0) || 0,
        tokensCacheRead: Number(r?.tokens_cache_read ?? 0) || 0,
        costUsd: Number(r?.cost ?? 0) || 0,
        ts: created,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Map OpenCode's own `idle_outcome` vocabulary. Assuming the obvious
 * "completed"/"abandoned" silently reads every task on this host as a failure.
 */
function normaliseOutcome(raw: unknown): TaskOutcome["outcome"] {
  const v = String(raw ?? "").toLowerCase();
  if (!v) return "unknown";
  if (v === "succeeded" || v === "success" || v === "completed" || v === "done") {
    return "succeeded";
  }
  if (v === "failed" || v === "error" || v === "abandoned" || v === "cancelled") {
    return "failed";
  }
  if (v === "interrupted" || v === "paused") return "interrupted";
  return "unknown";
}

const totalTokens = (o: TaskOutcome): number =>
  o.tokensInput + o.tokensOutput + o.tokensCacheRead;

/** Roll outcomes up per model, best solved-rate first. */
export function qualityByModel(outcomes: TaskOutcome[]): ModelQuality[] {
  const by = new Map<string, TaskOutcome[]>();
  for (const o of outcomes) {
    const list = by.get(o.model);
    if (list) list.push(o);
    else by.set(o.model, [o]);
  }

  const rows: ModelQuality[] = [];
  for (const [ref, list] of by) {
    const attempts = list.length;
    const solved = list.filter((o) => o.outcome === "succeeded").length;
    const failed = list.filter((o) => o.outcome === "failed").length;
    const interrupted = list.filter((o) => o.outcome === "interrupted").length;
    const unknown = attempts - solved - failed - interrupted;
    const ok = list.filter((o) => o.outcome === "succeeded");
    const bad = list.filter((o) => o.outcome !== "succeeded");
    const durations = list.map((o) => o.durationMs).sort((a, b) => a - b);
    // Proper median: average the two middle values when the count is even.
    const n = durations.length;
    const medianMs = n === 0 ? 0
      : n % 2 === 1
        ? durations[(n - 1) / 2]
        : (durations[n / 2 - 1] + durations[n / 2]) / 2;

    rows.push({
      ref,
      attempts,
      solved,
      failed,
      interrupted,
      unknown,
      wastedTokensPerAttempt:
        attempts > 0 ? bad.reduce((a, o) => a + totalTokens(o), 0) / attempts : 0,
      // Infinity when nothing solved: a model that never finishes has infinite
      // cost per solved task, and must not read as free.
      tokensPerSolved: solved > 0 ? ok.reduce((a, o) => a + totalTokens(o), 0) / solved : Infinity,
      costPerSolvedUsd: solved > 0 ? ok.reduce((a, o) => a + o.costUsd, 0) / solved : Infinity,
      solvedRate: attempts > 0 ? solved / attempts : 0,
      medianSeconds: medianMs / 1000,
    });
  }
  return rows.sort((a, b) => b.solvedRate - a.solvedRate || b.attempts - a.attempts);
}

/** Human-readable lines for `/jev-quality`. Never throws. */
export function formatQuality(rows: ModelQuality[], limit = 12): string {
  try {
    if (rows.length === 0) return "no delegated tasks measured yet";
    const head = "solved%  ok/fail/int  median  tok/solved   wasted/attempt  model";
    const lines = [head];
    for (const r of rows.slice(0, limit)) {
      const perSolved = Number.isFinite(r.tokensPerSolved)
        ? Math.round(r.tokensPerSolved).toLocaleString("en-US")
        : "never solved";
      const wasted =
        r.wastedTokensPerAttempt > 0
          ? Math.round(r.wastedTokensPerAttempt).toLocaleString("en-US")
          : "-";
      lines.push(
        `${(r.solvedRate * 100).toFixed(0).padStart(5)}%  ` +
          `${`${r.solved}/${r.failed}/${r.interrupted}`.padEnd(12)} ` +
          `${`${r.medianSeconds.toFixed(0)}s`.padStart(6)}  ` +
          `${perSolved.padStart(11)}  ${wasted.padStart(15)}  ${r.ref}`,
      );
    }
    return lines.join("\n");
  } catch {
    return "quality data unavailable";
  }
}

/**
 * Feedback term for the picker: how badly did this model fail here?
 *
 * Higher is worse. Counts non-success outcomes plus the tokens they burned,
 * normalised per attempt. Deliberately small and capped so it nudges rather
 * than decides — capacity and health still dominate.
 */
export function flailScore(outcomes: TaskOutcome[], ref: string): number {
  const mine = outcomes.filter((o) => o.model === ref);
  if (mine.length === 0) return 0;
  const notSolved = mine.filter((o) => o.outcome !== "succeeded").length;
  const wasted = notSolved > 0
    ? mine.filter((o) => o.outcome !== "succeeded")
          .reduce((a, o) => a + totalTokens(o), 0) / notSolved
    : 0;
  // Scale so ~1M wasted tokens per failed attempt is "bad"; capped at 5.
  const raw = notSolved / mine.length + wasted / 2_000_000;
  return Math.min(raw, 5);
}

/** Join a bridge decision back to its measured outcome, when we saw it land. */
export function outcomeForDecision(
  outcomes: TaskOutcome[],
  decision: BridgeDecision,
): TaskOutcome | undefined {
  return outcomes.find((o) => o.sessionID === decision.sessionID);
}

/** Per-lane rollup — which lane is failing most? */
export function qualityByLane(outcomes: TaskOutcome[]): ModelQuality[] {
  return qualityByModel(outcomes.map((o) => ({ ...o, model: o.lane || "(none)" })));
}

/** Same storage root the usage reader uses. */
export function outcomesDbPath(): string {
  const base =
    process.env.OPENCODE_DATA_DIR?.trim() ||
    process.env.OPENCODE_STATE_DIR?.trim() ||
    join(homedir(), ".local", "share", "opencode");
  return join(base, "opencode.db");
}

async function openDatabase(path: string): Promise<Db | undefined> {
  try {
    const mod: any = await import("bun:sqlite");
    const ctor = mod?.Database ?? mod?.default?.Database;
    if (!ctor) return undefined;
    return new ctor(path, { readonly: true, create: false }) as Db;
  } catch {
    return undefined;
  }
}
