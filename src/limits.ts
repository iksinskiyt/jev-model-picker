import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BudgetInfo, BudgetPolicy, BudgetSnapshot, PlanId } from "./types";

/**
 * Plan-aware budgeting.
 *
 * OpenCode Go is a flat subscription with **per-model** monthly dollar
 * allowances (plus 5-hour/weekly caps at 20%/50% of the monthly number).
 * A "best" model whose bucket just ran dry is worse than the second-best
 * model that still has room — which is exactly what bit us when four fixers
 * died on an exhausted free-model quota.
 *
 * This module gives the picker that picture:
 *   - the static plan tables (allowances + token prices) per plan,
 *   - *live* usage for this account read from OpenCode's own session DB,
 *   - a cached snapshot the picker consults before choosing a model.
 *
 * Usage is read read-only from `session_v2`, which stores one row per session
 * with its model and cumulative token counts — that covers every session on
 * this machine (orchestrator turns included, not just JEV's own decisions).
 */

export const GO_PROVIDER = "opencode-go";

export type ModelPrice = { input: number; output: number; cacheRead: number };

/**
 * USD per million tokens for Go models, taken from the Go plan tables.
 * `cacheRead` is the cached-input price, which dominates real agent traffic
 * (a long session is mostly cached context re-reads).
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03 },
  "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "kimi-k3.1-pro": { input: 2.0, output: 10.0, cacheRead: 0.2 },
  "kimi-k3": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "kimi-k2.7-code": { input: 0.95, output: 4.0, cacheRead: 0.19 },
  "longcat-2.0": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "step-5-preview": { input: 1.0, output: 2.7, cacheRead: 0.1 },
  "mimo-v2.6-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "mimo-v2.6-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  "mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "mimo-v2.5-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  "minimax-m3.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.015 },
  "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06 },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002 },
  "muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002 },
  "qwen3.8-max": { input: 2.0, output: 6.0, cacheRead: 0.25 },
  "qwen3.8-flash": { input: 0.15, output: 0.47, cacheRead: 0.016 },
  "qwen3.7-plus": { input: 0.4, output: 1.6, cacheRead: 0.04 },
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
  hy4: { input: 0.834, output: 2.501, cacheRead: 0.042 },
  "hy4-preview": { input: 0.834, output: 2.501, cacheRead: 0.042 },
  hy3: { input: 0.14, output: 0.58, cacheRead: 0.035 },
  "grok-4.7": { input: 2.0, output: 6.0, cacheRead: 0.5 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "gemini-4-argon": { input: 2.0, output: 10.0, cacheRead: 0.1 },
};

/** Monthly dollar allowance per model, by plan. */
export const PLAN_LIMITS: Record<PlanId, Record<string, number>> = {
  go: {
    "glm-5.3-flash": 60,
    "glm-5.3": 15,
    "glm-5.2": 60,
    "kimi-k3.1-pro": 15,
    "kimi-k3": 15,
    "kimi-k2.7-code": 60,
    "longcat-2.0": 60,
    "step-5-preview": 15,
    "mimo-v2.6-flash": 60,
    "mimo-v2.6-pro": 15,
    "mimo-v2.5": 60,
    "mimo-v2.5-pro": 15,
    "minimax-m3.1-flash": 20,
    "minimax-m3": 60,
    "muse-spark-1.3-contributor": 60,
    "muse-spark-1.2-contributor": 60,
    "qwen3.8-max": 15,
    "qwen3.8-flash": 30,
    "qwen3.7-plus": 60,
    "deepseek-v4.1-flash": 100,
    "deepseek-v4-pro": 15,
    hy4: 60,
    "hy4-preview": 30,
    hy3: 60,
    "grok-4.7": 15,
    "gpt-6-luna": 15,
    "gpt-5.6-luna": 15,
    "claude-haiku-5-5": 15,
    "gemini-4-argon": 30,
  },
  "go-plus": {
    "glm-5.3-flash": 180,
    "glm-5.3": 120,
    "glm-5.2": 180,
    "kimi-k3.1-pro": 60,
    "kimi-k3": 60,
    "kimi-k2.7-code": 180,
    "longcat-2.0": 240,
    "step-5-preview": 60,
    "mimo-v2.6-flash": 120,
    "mimo-v2.6-pro": 60,
    "mimo-v2.5": 120,
    "mimo-v2.5-pro": 60,
    "minimax-m3.1-flash": 80,
    "minimax-m3": 180,
    "muse-spark-1.3-contributor": 120,
    "muse-spark-1.2-contributor": 120,
    "qwen3.8-max": 60,
    "qwen3.8-flash": 90,
    "qwen3.7-plus": 180,
    "deepseek-v4.1-flash": 200,
    "deepseek-v4-pro": 60,
    hy4: 240,
    "hy4-preview": 120,
    hy3: 240,
    "grok-4.7": 60,
    "gpt-6-luna": 60,
    "gpt-5.6-luna": 60,
    "claude-haiku-5-5": 60,
    "gemini-4-argon": 120,
  },
  "go-teams": {
    "glm-5.3-flash": 65,
    "glm-5.3": 20,
    "glm-5.2": 65,
    "kimi-k3.1-pro": 20,
    "kimi-k3": 20,
    "kimi-k2.7-code": 65,
    "longcat-2.0": 65,
    "step-5-preview": 20,
    "mimo-v2.6-flash": 65,
    "mimo-v2.6-pro": 20,
    "mimo-v2.5": 65,
    "mimo-v2.5-pro": 20,
    "minimax-m3.1-flash": 25,
    "minimax-m3": 65,
    "muse-spark-1.3-contributor": 65,
    "muse-spark-1.2-contributor": 65,
    "qwen3.8-max": 20,
    "qwen3.8-flash": 35,
    "qwen3.7-plus": 65,
    "deepseek-v4.1-flash": 105,
    "deepseek-v4-pro": 20,
    hy4: 65,
    "hy4-preview": 35,
    hy3: 65,
    "grok-4.7": 20,
    "gpt-6-luna": 20,
    "gpt-5.6-luna": 20,
    "claude-haiku-5-5": 20,
    "gemini-4-argon": 35,
  },
};

export const PLAN_IDS: readonly PlanId[] = ["go", "go-plus", "go-teams"];

/** `opencode-go/glm-5.3` -> `glm-5.3`; other refs pass through unchanged. */
export function bareModel(ref: string): string {
  if (!ref) return "";
  const idx = ref.lastIndexOf("/");
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

export function providerOf(ref: string): string {
  const idx = ref.lastIndexOf("/");
  return idx >= 0 ? ref.slice(0, idx) : "";
}

/** Allowance + price for a ref on a plan. Undefined when uncapped/unknown. */
export function planEntry(
  plan: PlanId,
  ref: string,
): { limitUsd: number; price: ModelPrice } | undefined {
  const bare = bareModel(ref);
  const limit = PLAN_LIMITS[plan]?.[bare];
  const price = MODEL_PRICES[bare];
  if (limit === undefined || !price) return undefined;
  // A provider-qualified ref only counts when it names Go. The same bare id on
  // NIM/Console is pay-as-you-go and has no shared bucket to keep track of.
  const provider = providerOf(ref);
  if (provider && provider !== GO_PROVIDER) return undefined;
  return { limitUsd: limit, price };
}

/** True when the ref belongs to a Go-capped family. */
export function isCappedModel(ref: string): boolean {
  return bareModel(ref) in MODEL_PRICES;
}

export type TokenUsage = { input: number; output: number; cacheRead: number };

/** USD cost for token usage at a model's prices. */
export function costOf(price: ModelPrice, tokens: TokenUsage): number {
  const value =
    (Math.max(0, tokens.input) * price.input +
      Math.max(0, tokens.output) * price.output +
      Math.max(0, tokens.cacheRead) * price.cacheRead) /
    1e6;
  return Number.isFinite(value) ? value : 0;
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** First instant of the current UTC month — Go's allowance window. */
export function monthStartUtc(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

/** A window's share of the monthly cap: month 100%, week 50%, 5h 20%. */
export function windowCap(
  limitUsd: number,
  window: "month" | "week" | "5h",
): number {
  const share = window === "month" ? 1 : window === "week" ? 0.5 : 0.2;
  return limitUsd * share;
}

// ---------------------------------------------------------------------------
// Live usage, read from OpenCode's own session database
// ---------------------------------------------------------------------------

export type UsageWindow = "month" | "week" | "5h";

export interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  sessions: number;
  lastUpdated: number;
}

/** Usage per bare model id inside a time window. */
export type UsageMap = Record<string, UsageBucket>;

export function sessionDbPath(): string {
  const override = process.env.JEV_MODEL_PICKER_DB?.trim();
  if (override) return override;
  const base =
    process.env.OPENCODE_DATA_DIR?.trim() ||
    process.env.OPENCODE_STATE_DIR?.trim() ||
    join(homedir(), ".local", "share", "opencode");
  return join(base, "opencode.db");
}

type Db = {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
  close: () => void;
};

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

/**
 * Aggregate token usage per model from `session_v2`.
 *
 * `window` filters by `time_updated` so monthly/weekly/5-hour caps can each be
 * evaluated. Reads are read-only and never throw — a missing/locked DB simply
 * yields an empty map and the picker behaves as if no budget data existed.
 *
 * Accuracy note: `session_v2` stores **cumulative** per-session totals, so a
 * session opened before the window is charged to it in full. That makes the
 * estimator deliberately pessimistic for long-lived sessions — which is the
 * right bias for this feature: it is exactly the case where a user "runs out
 * very quickly" without noticing. `input` and `cacheRead` are treated as
 * disjoint buckets (AI-SDK semantics).
 */
export async function readUsageByModel(
  window: UsageWindow,
  dbPath: string = sessionDbPath(),
  now: number = Date.now(),
): Promise<UsageMap> {
  if (!dbPath || !existsSync(dbPath)) return {};
  const db = await openDatabase(dbPath);
  if (!db) return {};

  const since =
    window === "month"
      ? monthStartUtc(now)
      : window === "week"
        ? now - WEEK_MS
        : now - FIVE_HOURS_MS;

  try {
    const rows = db
      .prepare(
        `select model,
                sum(tokens_input) as tokens_input,
                sum(tokens_output) as tokens_output,
                sum(tokens_cache_read) as tokens_cache_read,
                count(*) as sessions,
                max(time_updated) as last_updated
           from session_v2
          where model is not null and time_updated >= ?
          group by model`,
      )
      .all(since) as any[];

    const out: UsageMap = {};
    for (const row of rows ?? []) {
      const bare = modelIdFromColumn(row?.model);
      if (!bare) continue;
      const bucket = out[bare] ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        sessions: 0,
        lastUpdated: 0,
      };
      bucket.input += toNum(row?.tokens_input);
      bucket.output += toNum(row?.tokens_output);
      bucket.cacheRead += toNum(row?.tokens_cache_read);
      bucket.sessions += toNum(row?.sessions);
      bucket.lastUpdated = Math.max(bucket.lastUpdated, toNum(row?.last_updated));
      out[bare] = bucket;
    }
    return out;
  } catch {
    return {};
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `session_v2.model` is a JSON blob; fall back to a regex scavenge. */
export function modelIdFromColumn(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    const id = parsed?.id ?? parsed?.model ?? parsed?.modelID;
    if (typeof id === "string" && id) return id;
  } catch {
    // fall through
  }
  const m = /"id"\s*:\s*"([^"]+)"/.exec(value);
  return m?.[1];
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

let snapshotCache: { at: number; plan: PlanId; snapshot: BudgetSnapshot } | undefined;

export async function budgetSnapshot(opts: {
  plan: PlanId;
  ttlMs?: number;
  now?: number;
  dbPath?: string;
}): Promise<BudgetSnapshot> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? 60_000;
  if (
    snapshotCache &&
    now - snapshotCache.at < ttl &&
    snapshotCache.plan === opts.plan
  ) {
    return snapshotCache.snapshot;
  }

  const byRef: Record<string, BudgetInfo> = {};
  if (PLAN_LIMITS[opts.plan]) {
    const [month, week, fiveHours] = await Promise.all([
      readUsageByModel("month", opts.dbPath, now),
      readUsageByModel("week", opts.dbPath, now),
      readUsageByModel("5h", opts.dbPath, now),
    ]);
    for (const bare of Object.keys(PLAN_LIMITS[opts.plan])) {
      const limitUsd = PLAN_LIMITS[opts.plan][bare];
      const price = MODEL_PRICES[bare];
      if (!price) continue;
      const usedUsd = costOf(price, month[bare] ?? emptyBucket());
      const usedWeek = costOf(price, week[bare] ?? emptyBucket());
      const used5h = costOf(price, fiveHours[bare] ?? emptyBucket());
      const remainingUsd = Math.max(0, limitUsd - usedUsd);
      const cap5h = windowCap(limitUsd, "5h");
      const capWeek = windowCap(limitUsd, "week");
      byRef[`${GO_PROVIDER}/${bare}`] = {
        ref: `${GO_PROVIDER}/${bare}`,
        limitUsd,
        usedUsd,
        used5h,
        cap5h,
        usedWeek,
        capWeek,
        remainingUsd,
        remainingPct: limitUsd > 0 ? remainingUsd / limitUsd : 1,
        exhausted:
          remainingUsd <= 0 || used5h >= cap5h || usedWeek >= capWeek,
      };
    }
  }

  const snapshot: BudgetSnapshot = { asOf: now, plan: opts.plan, byRef };
  snapshotCache = { at: now, plan: opts.plan, snapshot };
  return snapshot;
}

function emptyBucket(): UsageBucket {
  return { input: 0, output: 0, cacheRead: 0, sessions: 0, lastUpdated: 0 };
}

/** Test seam: drop the cached snapshot. */
export function resetBudgetCache(): void {
  snapshotCache = undefined;
}

export function budgetFor(
  snapshot: BudgetSnapshot | undefined,
  ref: string,
): BudgetInfo | undefined {
  if (!snapshot || !ref) return undefined;
  // A ref naming another provider (nvidia/..., opencode/...) is not drawing
  // on the Go subscription, so it has no bucket to report.
  const provider = providerOf(ref);
  if (provider && provider !== GO_PROVIDER) return undefined;
  return snapshot.byRef[getBudgetRef(bareModel(ref))];
}

function getBudgetRef(bare: string): string {
  return `${GO_PROVIDER}/${bare}`;
}

/** `"$42.30/$60 left this month"` / `"budget exhausted"` / undefined. */
export function describeBudget(info: BudgetInfo | undefined): string | undefined {
  if (!info) return undefined;
  if (info.exhausted) {
    const why = info.remainingUsd <= 0 ? "monthly" : "window";
    return `budget exhausted (${why} cap)`;
  }
  return `$${info.remainingUsd.toFixed(2)}/$${info.limitUsd} left this month`;
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  enabled: true,
  plan: "go",
  floorUsd: 0.5,
  floorPct: 3,
  windowAware: true,
};

/** A model is "tight" when what's left cannot absorb another real task. */
export function budgetTight(
  info: BudgetInfo | undefined,
  policy: BudgetPolicy,
): boolean {
  if (!policy.enabled || !info) return false;
  if (info.remainingUsd <= policy.floorUsd) return true;
  if (info.limitUsd > 0 && info.remainingPct * 100 <= policy.floorPct) return true;
  if (policy.windowAware && info.used5h >= info.cap5h) return true;
  if (policy.windowAware && info.usedWeek >= info.capWeek) return true;
  return false;
}

/**
 * Split candidates into those with room (preferred) and those at their cap.
 * Models the snapshot knows nothing about (free/uncapped, other providers)
 * always count as "preferred" — an unknown budget must never block a pick.
 */
export function partitionByBudget<T extends { ref: string }>(
  items: readonly T[],
  snapshot: BudgetSnapshot | undefined,
  policy: BudgetPolicy,
): { preferred: T[]; tight: T[] } {
  if (!policy.enabled || !snapshot) return { preferred: [...items], tight: [] };
  const preferred: T[] = [];
  const tight: T[] = [];
  for (const item of items) {
    const info = budgetFor(snapshot, item.ref);
    if (budgetTight(info, policy)) tight.push(item);
    else preferred.push(item);
  }
  return { preferred, tight };
}

/** Criteria text appended to a candidate's description. */
export function budgetNote(
  info: BudgetInfo | undefined,
): string | undefined {
  if (!info) return undefined;
  const label = describeBudget(info);
  if (!label) return undefined;
  const used = info.usedUsd.toFixed(2);
  return `${label} ($${used} used of $${info.limitUsd}/mo)`;
}

/** Merge plugin options with TUI bridge overrides, validating every field. */
export function resolveBudgetPolicy(
  base: BudgetPolicy,
  override?: unknown,
): BudgetPolicy {
  const o = override && typeof override === "object" && !Array.isArray(override)
    ? (override as Record<string, unknown>)
    : undefined;
  if (!o) return base;
  const plan = PLAN_IDS.includes(String(o.plan) as PlanId)
    ? (String(o.plan) as PlanId)
    : base.plan;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    plan,
    floorUsd: finiteOr(o.floorUsd, base.floorUsd),
    floorPct: finiteOr(o.floorPct, base.floorPct),
    windowAware:
      typeof o.windowAware === "boolean" ? o.windowAware : base.windowAware,
  };
}

function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}
