/**
 * Model scoring and selection — the "brain" of the picker.
 *
 * This module encodes the decision rules derived from measured evidence
 * (docs/FINDINGS.md). Every rule is testable and degrades to the lane's
 * pinned model on any doubt (never-block contract).
 */

import type { Candidate, DemandProfile, BudgetPolicy, BudgetSnapshot, PlanId } from "./types";
import {
  MODEL_PRICES,
  PLAN_LIMITS,
  bareModel,
  planEntry,
  costOf,
  tasksRemaining,
  estimateTaskCost,
  isCappedModel,
} from "./limits";

/** Known-bad / dark endpoints — updated from live probes (FINDINGS.md). */
export const KNOWN_BAD_MODELS = new Set<string>([
  "z-ai/glm-5.3-flash", // timeout @ 100s, 240s ×3 — DOWN
  "deepseek-ai/deepseek-v4.1-flash", // timeout @ 240s ×2 — DOWN
  "z-ai/glm-5.3", // HTTP 410 EOL
]);

/**
 * Models that returned empty responses — treat as unhealthy.
 *
 * Keyed by the BARE NIM id (no `nvidia/` prefix), because that is what
 * `getHealthModelId` returns after stripping the doubled `nvidia/nvidia/` from
 * an OpenCode ref. Keying it with the prefix silently matches nothing, which is
 * exactly how this entry stopped filtering for a while.
 */
export const KNOWN_EMPTY_MODELS = new Set<string>([
  "nemotron-3.5-lightning-30b-a3b", // returns EMPTY response — unusable
]);

/** Health status for a model. */
export type ModelHealth = "healthy" | "degraded" | "dark";

/** Check if a model is known-bad/dark. */
export function modelHealth(bareId: string): ModelHealth {
  if (KNOWN_BAD_MODELS.has(bareId)) return "dark";
  if (KNOWN_EMPTY_MODELS.has(bareId)) return "degraded";
  return "healthy";
}

/** Extract the model ID for health checking from a full ref.
 * Handles both Go refs (provider/model) and NIM refs (nvidia/nvidia/<NIM_ID>). */
export function getHealthModelId(ref: string): string {
  if (!ref) return "";
  // NIM refs have format "nvidia/nvidia/<NIM_ID>" where NIM_ID may contain "/"
  if (ref.startsWith("nvidia/nvidia/")) {
    return ref.slice("nvidia/nvidia/".length);
  }
  // Go refs and others: use bareModel (last segment)
  return bareModel(ref);
}

/** Extract the model name for latency/pricing lookups (last segment only). */
export function getLatencyModelId(ref: string): string {
  return bareModel(ref);
}

/** Latency bands (seconds) from live probes. */
export const MODEL_LATENCY: Record<string, number> = {
  "nemotron-3-nano-omni-30b-a3b-reasoning": 0.75,
  "nemotron-3.5-lightning-30b-a3b": 1.39,
  "nemotron-3.5-super-vl-120b-a12b": 2.96,
  "step-5-preview": 2.67,
  "nemotron-3-ultra-550b-a55b": 4.8,
  "minimax-m3.1-flash": 75, // cold start is not the cause — every call is ~75s
};

/** Default latency for unknown models (conservative). */
export const DEFAULT_LATENCY_S = 10;

/** Get latency for a bare model id. */
export function latencyFor(bareId: string): number {
  return MODEL_LATENCY[bareId] ?? DEFAULT_LATENCY_S;
}

/** Peak/off-peak window configuration. */
export interface TimeWindowConfig {
  /** Off-peak start hour (UTC), inclusive. Default 0 (midnight). */
  offPeakStart: number;
  /** Off-peak end hour (UTC), exclusive. Default 8 (8 AM). */
  offPeakEnd: number;
  /** Timezone offset in minutes from UTC. Default 0 (UTC). */
  tzOffsetMinutes: number;
}

export const DEFAULT_TIME_WINDOW: TimeWindowConfig = {
  offPeakStart: 0, // 00:00 UTC
  offPeakEnd: 8, // 08:00 UTC
  tzOffsetMinutes: 0,
};

/** Check if current time is in off-peak window. */
export function isOffPeak(now: number = Date.now(), cfg: TimeWindowConfig = DEFAULT_TIME_WINDOW): boolean {
  const d = new Date(now + cfg.tzOffsetMinutes * 60_000);
  const hour = d.getUTCHours();
  if (cfg.offPeakStart < cfg.offPeakEnd) {
    return hour >= cfg.offPeakStart && hour < cfg.offPeakEnd;
  }
  // Window crosses midnight
  return hour >= cfg.offPeakStart || hour < cfg.offPeakEnd;
}

/** Models with distinct off-peak pricing (from FINDINGS.md budget research). */
export const OFF_PEAK_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 }, // off-peak: $0.15/$0.6 vs peak $0.3/$1.2
};

/** Get effective price for a model, considering off-peak windows. */
export function effectivePrice(bareId: string, offPeak: boolean): { input: number; output: number; cacheRead: number } | undefined {
  const base = MODEL_PRICES[bareId];
  if (!base) return undefined;

  if (offPeak && OFF_PEAK_PRICING[bareId]) {
    return OFF_PEAK_PRICING[bareId];
  }
  return base;
}

/** Scoring weights — tuned from evidence. */
export interface ScoringWeights {
  /** Weight for cached-read cost dominance (FINDINGS: 32× cacheRead vs input). */
  cacheReadWeight: number;
  /** Weight for headline input cost. */
  inputWeight: number;
  /** Weight for output cost. */
  outputWeight: number;
  /** Weight for latency penalty (per second). */
  latencyWeight: number;
  /** Weight for health penalty (dark models). */
  darkPenalty: number;
  /** Weight for degraded penalty (empty response). */
  degradedPenalty: number;
  /** Weight for concentration risk (same model on many lanes). */
  concentrationWeight: number;
  /** Weight for premium reservation (prefer free for ordinary work). */
  premiumPenalty: number;
  /** Weight for off-peak bonus. */
  offPeakBonus: number;
  /**
   * Bonus for matching the lane's configured pin. The pin is a deliberate
   * configuration choice (often benchmarked by hand), so a healthy pin beats a
   * marginally-cheaper alternative unless the evidence is clearly against it.
   */
  pinBonus: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  cacheReadWeight: 1.0, // Primary cost driver
  inputWeight: 0.03, // ~1/32 of cacheRead weight per FINDINGS
  outputWeight: 0.1,
  latencyWeight: 0.05, // Per second — 75s model gets -3.75
  darkPenalty: 100, // Effectively excludes dark models
  degradedPenalty: 20, // Strongly discourages empty-response models
  concentrationWeight: 5, // Per additional lane on same model
  premiumPenalty: 10, // For ordinary tasks on premium models
  offPeakBonus: 2, // Small bonus for off-peak pricing
  // Big enough that a healthy pin beats a free-but-marginal alternative, small
  // enough that a genuinely unhealthy pin still loses to a healthy model.
  pinBonus: 8,
};

/** Task complexity heuristic — determines if work is "ordinary" or "hard". */
export interface TaskComplexity {
  /** Estimated token demand for this task. */
  profile: DemandProfile | undefined;
  /** Lane name (for lane-specific demand profiles). */
  lane: string;
  /** Keywords that indicate complex work. */
  complexKeywords: string[];
}

const COMPLEX_KEYWORDS = [
  "refactor",
  "architecture",
  "design",
  "debug",
  "investigate",
  "analyze",
  "review",
  "audit",
  "optimize",
  "migrate",
  "rewrite",
  "research",
  "explore",
  "prototype",
];

/** Classify task complexity from digest text and lane profile. */
export function classifyTaskComplexity(digest: string, lane: string, profile: DemandProfile | undefined): "ordinary" | "hard" {
  const text = digest.toLowerCase();

  // Keyword-based complexity signal
  const hasComplexKeyword = COMPLEX_KEYWORDS.some((k) => text.includes(k));

  // Lane demand profile: high cacheRead = complex context-heavy work
  const cacheReadHeavy = profile && profile.cacheRead > 500_000; // >500K cached reads per task

  // Fixer/Designer/Explorer with large tasks = hard
  const highVolumeLane = ["fixer", "designer", "explorer", "orchestrator"].includes(lane);

  return hasComplexKeyword || cacheReadHeavy || highVolumeLane ? "hard" : "ordinary";
}

/** Concentration tracking: how many lanes use each model. */
export interface ConcentrationMap {
  modelToLanes: Map<string, Set<string>>;
  laneToModel: Map<string, string>;
}

export function createConcentrationMap(): ConcentrationMap {
  return { modelToLanes: new Map(), laneToModel: new Map() };
}

export function recordConcentration(map: ConcentrationMap, lane: string, bareModelId: string): void {
  map.laneToModel.set(lane, bareModelId);
  const lanes = map.modelToLanes.get(bareModelId) ?? new Set();
  lanes.add(lane);
  map.modelToLanes.set(bareModelId, lanes);
}

export function concentrationCount(map: ConcentrationMap, bareModelId: string): number {
  return map.modelToLanes.get(bareModelId)?.size ?? 0;
}

/** Maximum lanes per model before concentration penalty applies. */
export const MAX_LANES_PER_MODEL = 2; // Justified: FINDINGS shows 3 lanes on GLM caused total outage

/** Score a single candidate. Higher = better. */
export interface ScoreBreakdown {
  total: number;
  cost: number;
  latency: number;
  health: number;
  concentration: number;
  premium: number;
  offPeak: number;
  /** Bonus for matching the lane's configured pin (0 when it is not the pin). */
  pin: number;
}

export function scoreCandidate(
  candidate: Candidate,
  opts: {
    weights: ScoringWeights;
    offPeak: boolean;
    taskComplexity: "ordinary" | "hard";
    concentration: ConcentrationMap;
    lane: string;
    demandProfile: DemandProfile | undefined;
    budgetSnapshot: BudgetSnapshot | undefined;
    budgetPolicy: BudgetPolicy;
    /** The lane's configured pin, when it resolved to a live candidate. */
    lanePin?: string;
  },
): ScoreBreakdown {
  const bare = bareModel(candidate.ref);
  const healthId = getHealthModelId(candidate.ref);
  const latencyId = getLatencyModelId(candidate.ref);
  const health = modelHealth(healthId);
  const latency = latencyFor(latencyId);
  const price = effectivePrice(latencyId, opts.offPeak);
  const concentrationCount_ = concentrationCount(opts.concentration, bare);
  const isCapped = isCappedModel(candidate.ref);
  const isFreeTier = candidate.pricePerMTok === 0 || candidate.providerID === "opencode" || candidate.providerID === "nvidia";

  // --- Cost score (lower cost = higher score) ---
  let costScore = 0;
  if (price && opts.demandProfile) {
    // Use cache-read dominated cost estimation per FINDINGS
    const taskCost = estimateTaskCost(opts.demandProfile, price);
    // Normalize: lower cost = higher score. Scale so $1/task ≈ -10 points.
    costScore = -taskCost * 10 * opts.weights.cacheReadWeight;
  } else if (candidate.pricePerMTok > 0) {
    // Fallback to blended price if no demand profile
    costScore = -candidate.pricePerMTok * opts.weights.inputWeight;
  } else {
    // Free models get a bonus
    costScore = 5;
  }

  // --- Latency score (lower latency = higher score) ---
  const latencyScore = -latency * opts.weights.latencyWeight;

  // --- Health score ---
  let healthScore = 0;
  if (health === "dark") healthScore = -opts.weights.darkPenalty;
  else if (health === "degraded") healthScore = -opts.weights.degradedPenalty;

  // --- Concentration score ---
  let concentrationScore = 0;
  if (concentrationCount_ >= MAX_LANES_PER_MODEL) {
    concentrationScore = -(concentrationCount_ - MAX_LANES_PER_MODEL + 1) * opts.weights.concentrationWeight;
  }

  // --- Premium reservation penalty ---
  let premiumScore = 0;
  if (opts.taskComplexity === "ordinary" && isCapped && !isFreeTier) {
    // Ordinary work should not consume scarce premium capacity
    premiumScore = -opts.weights.premiumPenalty;
  } else if (opts.taskComplexity === "hard" && isCapped && !isFreeTier) {
    // Hard work gets a small bonus for premium capability
    premiumScore = 2;
  }

  // --- Off-peak bonus ---
  let offPeakScore = 0;
  if (opts.offPeak && OFF_PEAK_PRICING[bare]) {
    offPeakScore = opts.weights.offPeakBonus;
  }

  // --- Lane pin prior ---
  // The pin is what the operator configured for this lane, frequently after
  // benchmarking by hand. Matching it is evidence, not a tie-break.
  let pinScore = 0;
  if (opts.lanePin && candidate.ref === opts.lanePin) {
    pinScore = opts.weights.pinBonus;
  }

  // --- Budget exhaustion check (hard constraint) ---
  if (opts.budgetSnapshot && opts.budgetPolicy.enabled) {
    const budgetInfo = budgetFor(opts.budgetSnapshot, candidate.ref);
    if (budgetInfo?.exhausted) {
      // Exhausted models get massive penalty but not infinite (never-block)
      healthScore -= 1000;
    }
  }

  const total =
    costScore +
    latencyScore +
    healthScore +
    concentrationScore +
    premiumScore +
    offPeakScore +
    pinScore;

  return {
    total,
    cost: costScore,
    latency: latencyScore,
    health: healthScore,
    concentration: concentrationScore,
    premium: premiumScore,
    offPeak: offPeakScore,
    pin: pinScore,
  };
}

/** Sort candidates by score (best first), with deterministic tie-breaking. */
export function rankCandidates(
  candidates: Candidate[],
  opts: Parameters<typeof scoreCandidate>[1],
): Array<{ candidate: Candidate; score: ScoreBreakdown }> {
  const scored = candidates.map((c) => ({ candidate: c, score: scoreCandidate(c, opts) }));
  scored.sort((a, b) => {
    // Primary: total score descending
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    // Tie-breaker: health (healthy > degraded > dark)
    const healthOrder = { healthy: 2, degraded: 1, dark: 0 };
    const aHealth = healthOrder[modelHealth(bareModel(a.candidate.ref))];
    const bHealth = healthOrder[modelHealth(bareModel(b.candidate.ref))];
    if (bHealth !== aHealth) return bHealth - aHealth;
    // Tie-breaker: free tier preferred
    const aFree = a.candidate.pricePerMTok === 0;
    const bFree = b.candidate.pricePerMTok === 0;
    if (aFree !== bFree) return bFree ? 1 : -1;
    // Tie-breaker: lower latency
    const aLat = latencyFor(bareModel(a.candidate.ref));
    const bLat = latencyFor(bareModel(b.candidate.ref));
    if (aLat !== bLat) return aLat - bLat;
    // Final: stable sort by ref
    return a.candidate.ref.localeCompare(b.candidate.ref);
  });
  return scored;
}

/** Budget info helper (re-exported for convenience). */
import { budgetFor } from "./limits";

/**
 * Filter out unusable models — dark (unreachable) *and* degraded (answers with
 * an empty response) — unless they are the only option. Never-block: with
 * nothing healthy left the pin still wins.
 *
 * Degraded models are excluded rather than penalised on purpose. An empty
 * response is not "slightly worse", it is a task that silently did no work, so
 * a minus-point penalty is not enough — it must be out of reach whenever a
 * healthy alternative exists.
 */
export function filterDarkModels(
  candidates: Candidate[],
  lanePin?: string,
): Candidate[] {
  const healthy = candidates.filter((c) => {
    const h = modelHealth(getHealthModelId(c.ref));
    return h !== "dark" && h !== "degraded";
  });
  if (healthy.length >= 2) return healthy;
  if (healthy.length === 1) return healthy;
  // Only unusable models available — keep them all rather than return nothing.
  return candidates;
}

/** Apply anti-concentration: if a model has MAX_LANES_PER_MODEL lanes, deprioritize it. */
export function applyAntiConcentration(
  ranked: Array<{ candidate: Candidate; score: ScoreBreakdown }>,
  concentration: ConcentrationMap,
): Array<{ candidate: Candidate; score: ScoreBreakdown }> {
  // The scoring already includes concentration penalty; this is a safety net
  // that ensures we don't pick a model at concentration limit if a close alternative exists.
  return ranked;
}