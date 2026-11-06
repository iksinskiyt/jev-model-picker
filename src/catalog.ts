import type { Candidate, PickerConfig } from "./types";
import {
  rankCandidates,
  filterDarkModels,
  modelHealth,
  latencyFor,
  DEFAULT_WEIGHTS,
  DEFAULT_TIME_WINDOW,
  createConcentrationMap,
  ConcentrationMap,
  classifyTaskComplexity,
  isOffPeak,
  recordConcentration,
} from "./optimize";
import { bareModel } from "./limits";

const EXCLUDE_ID = /(embed|rerank|guard|safety|moderation)/i;

/**
 * Blended USD per million output-equivalent tokens: mean of input and output
 * price, ignoring cache pricing. Multiple tiers (context sizes) take the last
 * one's read/write cache prices into account only for the mean's input half.
 * A model with no priced tiers is free (0).
 */
export function blendedPrice(costArr: readonly any[]): number {
  const tier = costArr[0];
  if (!tier) return 0;
  const input = Number(tier?.input ?? 0);
  const output = Number(tier?.output ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return 0;
  return (input + output) / 2;
}

/**
 * Default concentration map — in practice this should be shared across picks
 * to track cross-lane concentration. For now, each pick gets a fresh map.
 * TODO: persist concentration state in bridge/settings.
 */
let globalConcentration: ConcentrationMap = createConcentrationMap();

export function getGlobalConcentration(): ConcentrationMap {
  return globalConcentration;
}

export function resetGlobalConcentration(): void {
  globalConcentration = createConcentrationMap();
}

/**
 * Optimization context for evidence-based candidate ranking.
 */
export interface OptimizeContext {
  /** Task digest text for complexity classification. */
  taskDigest?: string;
  /** Live budget snapshot for exhaustion checks. */
  budgetSnapshot?: import("./types").BudgetSnapshot;
  /** Budget policy for capacity-aware filtering. */
  budgetPolicy?: import("./types").BudgetPolicy;
  /** Per-lane demand profile for cost estimation. */
  demandProfile?: import("./types").DemandProfile;
  /** Concentration map for anti-concentration (shared across picks). */
  concentration?: ConcentrationMap;
  /** Time window config for off-peak pricing. */
  timeWindow?: import("./optimize").TimeWindowConfig;
  /** Scoring weights (defaults to evidence-tuned values). */
  weights?: import("./optimize").ScoringWeights;
  /** Current timestamp for off-peak calculation. */
  now?: number;
}

/**
 * Build the candidate list offered to the picker for a given lane.
 *
 * - Auto: every enabled, tool-capable model from ctx.model.list()
 * - Lane pin (from OMO-Slim) is sorted first so criteria skew toward it
 * - Explicit config.lanes[lane] refs win when they resolve; if fewer than 2
 *   resolve (e.g. stale pins) we fall back to auto-discovery
 * - Evidence-based ranking: health, cache-read cost, latency, concentration, premium reservation, off-peak
 */
export async function listCandidates(
  ctx: any,
  cfg: PickerConfig,
  lane?: string,
  lanePin?: string,
  allowlist?: string[],
  optimizeCtx?: OptimizeContext,
): Promise<Candidate[]> {
  let models: any[] = [];
  try {
    const raw: any = await ctx?.model?.list?.();
    models = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.models)
        ? raw.models
        : Array.isArray(raw?.data)
          ? raw.data
          : [];
  } catch {
    models = [];
  }

  const seen = new Set<string>();
  const all: Candidate[] = [];

  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const providerID = String(m.providerID ?? m.provider?.id ?? "");
    const id = String(m.id ?? m.modelID ?? "");
    if (!providerID || !id) continue;

    const ref = `${providerID}/${id}`;
    if (seen.has(ref)) continue;

    const caps = m.capabilities ?? {};
    if (caps.tools === false) continue;
    if (EXCLUDE_ID.test(id)) continue;
    if (m.enabled === false) continue;
    if (m.status === "deprecated") continue;

    seen.add(ref);
    const costArr: any[] = Array.isArray(m.cost) ? m.cost : [];
    const paid = costArr.some(
      (c) => Number(c?.input ?? 0) > 0 || Number(c?.output ?? 0) > 0,
    );
    const pricePerMTok = blendedPrice(costArr);
    const context = Number(m.limit?.context ?? 0);
    const name = String(m.name ?? id);

    const parts: string[] = [name, `provider ${providerID}`, paid ? "paid" : "free"];
    if (context > 0) parts.push(`${Math.round(context / 1000)}K ctx`);
    const description = cfg.descriptions[ref] ?? parts.join(", ");

    all.push({ ref, providerID, id, name, description, pricePerMTok });
  }

  const explicit = lane ? cfg.lanes[lane] : undefined;
  let list = filterAllowlist(all, allowlist);

  if (explicit && explicit.length > 0) {
    // explicit config wins; if it resolves to fewer than 2 live refs the
    // picker simply skips and the call keeps its original model
    const byRef = new Map(all.map((c) => [c.ref, c]));
    list = explicit
      .map((r) => byRef.get(r))
      .filter((c): c is Candidate => !!c);
  }

  // Evidence-based ranking when optimization context is provided
  if (optimizeCtx) {
    const {
      taskDigest = "",
      budgetSnapshot,
      budgetPolicy,
      demandProfile,
      concentration = globalConcentration,
      timeWindow = DEFAULT_TIME_WINDOW,
      weights = DEFAULT_WEIGHTS,
      now = Date.now(),
    } = optimizeCtx;

    const offPeak = isOffPeak(now, timeWindow);
    const taskComplexity = classifyTaskComplexity(taskDigest, lane ?? "unknown", demandProfile);

    // Filter unusable models (dark + degraded) — never-block keeps the pin
    list = filterDarkModels(list, lanePin);

    // Rank by evidence-based scoring
    const ranked = rankCandidates(list, {
      weights,
      offPeak,
      taskComplexity,
      concentration,
      lane: lane ?? "unknown",
      demandProfile,
      budgetSnapshot,
      budgetPolicy: budgetPolicy ?? cfg.budget,
      lanePin,
    });

    list = ranked.map((r) => r.candidate);

    // Record concentration for picked model (top-ranked) — best effort
    if (list.length > 0 && lane) {
      const topBare = bareModel(list[0].ref);
      recordConcentration(concentration, lane, topBare);
    }
  } else if (list === all && lanePin) {
    // Legacy: pinned model first, everything else keeps catalog order
    list = [...all].sort(
      (a, b) => (a.ref === lanePin ? -1 : 0) - (b.ref === lanePin ? -1 : 0),
    );
  }

  const max = Math.max(2, cfg.policy.maxCandidates);
  return list.slice(0, max);
}

/** TUI-set allow-list restricts the candidate set; empty/undefined keeps all. */
function filterAllowlist(
  all: Candidate[],
  allowlist?: string[],
): Candidate[] {
  if (!allowlist || allowlist.length === 0) return all;
  const wanted = new Set(allowlist);
  return all.filter((c) => wanted.has(c.ref));
}
