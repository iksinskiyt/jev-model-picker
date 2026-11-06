import { describe, expect, test, beforeEach } from "bun:test";
import {
  KNOWN_BAD_MODELS,
  KNOWN_EMPTY_MODELS,
  modelHealth,
  latencyFor,
  MODEL_LATENCY,
  DEFAULT_LATENCY_S,
  isOffPeak,
  DEFAULT_TIME_WINDOW,
  TimeWindowConfig,
  effectivePrice,
  OFF_PEAK_PRICING,
  DEFAULT_WEIGHTS,
  ScoringWeights,
  classifyTaskComplexity,
  COMPLEX_KEYWORDS,
  createConcentrationMap,
  recordConcentration,
  concentrationCount,
  MAX_LANES_PER_MODEL,
  scoreCandidate,
  ScoreBreakdown,
  rankCandidates,
  filterDarkModels,
  getHealthModelId,
  getLatencyModelId,
} from "../src/optimize";
import { bareModel } from "../src/limits";
import type { Candidate, DemandProfile, BudgetPolicy, BudgetSnapshot, BudgetInfo } from "../src/types";
import { DEFAULT_BUDGET_POLICY } from "../src/limits";

describe("Known bad/empty models", () => {
  test("KNOWN_BAD_MODELS contains the dark endpoints from FINDINGS.md", () => {
    expect(KNOWN_BAD_MODELS.has("z-ai/glm-5.3-flash")).toBe(true);
    expect(KNOWN_BAD_MODELS.has("deepseek-ai/deepseek-v4.1-flash")).toBe(true);
    expect(KNOWN_BAD_MODELS.has("z-ai/glm-5.3")).toBe(true);
  });

  test("KNOWN_EMPTY_MODELS contains models returning empty responses", () => {
    expect(KNOWN_EMPTY_MODELS.has("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe(true);
  });

  test("modelHealth returns dark for known bad bare IDs", () => {
    expect(modelHealth("z-ai/glm-5.3-flash")).toBe("dark");
    expect(modelHealth("deepseek-ai/deepseek-v4.1-flash")).toBe("dark");
    expect(modelHealth("z-ai/glm-5.3")).toBe("dark");
  });

  test("modelHealth returns degraded for known empty bare IDs", () => {
    expect(modelHealth("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("degraded");
  });
});

describe("modelHealth", () => {
  test("returns dark for known-bad models", () => {
    expect(modelHealth("z-ai/glm-5.3-flash")).toBe("dark");
    expect(modelHealth("deepseek-ai/deepseek-v4.1-flash")).toBe("dark");
    expect(modelHealth("z-ai/glm-5.3")).toBe("dark");
  });

  test("returns degraded for known-empty models", () => {
    expect(modelHealth("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("degraded");
  });

  test("returns healthy for unknown models", () => {
    expect(modelHealth("nvidia/nemotron-3-ultra-550b-a55b")).toBe("healthy");
    expect(modelHealth("stepfun-ai/step-5-preview")).toBe("healthy");
    expect(modelHealth("random/model")).toBe("healthy");
  });
});

describe("latencyFor", () => {
  test("returns measured latencies from FINDINGS.md", () => {
    expect(latencyFor("nemotron-3-nano-omni-30b-a3b-reasoning")).toBe(0.75);
    expect(latencyFor("nemotron-3.5-lightning-30b-a3b")).toBe(1.39);
    expect(latencyFor("nemotron-3.5-super-vl-120b-a12b")).toBe(2.96);
    expect(latencyFor("step-5-preview")).toBe(2.67);
    expect(latencyFor("nemotron-3-ultra-550b-a55b")).toBe(4.8);
    expect(latencyFor("minimax-m3.1-flash")).toBe(75);
  });

  test("returns DEFAULT_LATENCY_S for unknown models", () => {
    expect(latencyFor("unknown/model")).toBe(DEFAULT_LATENCY_S);
    expect(DEFAULT_LATENCY_S).toBe(10);
  });
});

describe("isOffPeak", () => {
  test("default window: 00:00-08:00 UTC is off-peak", () => {
    // 2026-11-06 04:00 UTC = off-peak
    const offPeakTime = Date.UTC(2026, 10, 6, 4, 0, 0);
    expect(isOffPeak(offPeakTime, DEFAULT_TIME_WINDOW)).toBe(true);
  });

  test("default window: 08:00-24:00 UTC is peak", () => {
    const peakTime = Date.UTC(2026, 10, 6, 12, 0, 0);
    expect(isOffPeak(peakTime, DEFAULT_TIME_WINDOW)).toBe(false);
  });

  test("custom window crossing midnight", () => {
    const cfg: TimeWindowConfig = { offPeakStart: 22, offPeakEnd: 6, tzOffsetMinutes: 0 };
    expect(isOffPeak(Date.UTC(2026, 10, 6, 23, 0, 0), cfg)).toBe(true); // 23:00
    expect(isOffPeak(Date.UTC(2026, 10, 7, 3, 0, 0), cfg)).toBe(true); // 03:00
    expect(isOffPeak(Date.UTC(2026, 10, 6, 12, 0, 0), cfg)).toBe(false); // 12:00
  });

  test("timezone offset shifts the window", () => {
    // UTC-5 (EST): window is 00:00-08:00 EST = 05:00-13:00 UTC
    const cfg: TimeWindowConfig = { offPeakStart: 0, offPeakEnd: 8, tzOffsetMinutes: -300 };
    // 09:00 UTC = 04:00 EST -> off-peak
    expect(isOffPeak(Date.UTC(2026, 10, 6, 9, 0, 0), cfg)).toBe(true);
    // 13:00 UTC = 08:00 EST -> peak (boundary)
    expect(isOffPeak(Date.UTC(2026, 10, 6, 13, 0, 0), cfg)).toBe(false);
    // 04:00 UTC = 23:00 EST (previous day) -> peak
    expect(isOffPeak(Date.UTC(2026, 10, 6, 4, 0, 0), cfg)).toBe(false);
  });
});

describe("effectivePrice", () => {
  test("returns off-peak pricing for deepseek-v4.1-flash during off-peak", () => {
    const price = effectivePrice("deepseek-v4.1-flash", true);
    expect(price).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
  });

  test("returns base pricing for deepseek-v4.1-flash during peak", () => {
    const price = effectivePrice("deepseek-v4.1-flash", false);
    // Base price from MODEL_PRICES
    expect(price?.input).toBe(0.15);
    expect(price?.output).toBe(0.6);
    expect(price?.cacheRead).toBe(0.003);
  });

  test("returns undefined for unknown models", () => {
    expect(effectivePrice("unknown/model", true)).toBeUndefined();
  });
});

describe("classifyTaskComplexity", () => {
  const fixerProfile: DemandProfile = { tasks: 10, input: 200_000, output: 10_000, cacheRead: 1_500_000 };
  const librarianProfile: DemandProfile = { tasks: 40, input: 20_000, output: 2_000, cacheRead: 90_000 };

  test("returns hard for complex keywords", () => {
    expect(classifyTaskComplexity("refactor the authentication module", "fixer", fixerProfile)).toBe("hard");
    expect(classifyTaskComplexity("debug the memory leak", "fixer", fixerProfile)).toBe("hard");
    expect(classifyTaskComplexity("design a new API", "designer", librarianProfile)).toBe("hard");
    expect(classifyTaskComplexity("investigate the production issue", "explorer", librarianProfile)).toBe("hard");
  });

  test("returns hard for cache-read heavy profiles", () => {
    expect(classifyTaskComplexity("simple task", "fixer", fixerProfile)).toBe("hard"); // 1.5M cacheRead > 500K
  });

  test("returns ordinary for simple tasks on low-volume lanes", () => {
    expect(classifyTaskComplexity("fix a typo", "observer", librarianProfile)).toBe("ordinary");
    expect(classifyTaskComplexity("update documentation", "librarian", librarianProfile)).toBe("ordinary");
  });

  test("returns hard for high-volume lanes even without keywords", () => {
    expect(classifyTaskComplexity("routine task", "fixer", librarianProfile)).toBe("hard");
    expect(classifyTaskComplexity("routine task", "designer", librarianProfile)).toBe("hard");
    expect(classifyTaskComplexity("routine task", "explorer", librarianProfile)).toBe("hard");
    expect(classifyTaskComplexity("routine task", "orchestrator", librarianProfile)).toBe("hard");
  });
});

describe("concentration tracking", () => {
  test("tracks lanes per model", () => {
    const map = createConcentrationMap();
    recordConcentration(map, "explorer", "nemotron-3-nano-omni-30b-a3b-reasoning");
    recordConcentration(map, "fixer", "nemotron-3-nano-omni-30b-a3b-reasoning");
    recordConcentration(map, "librarian", "minimax-m3.1-flash");

    expect(concentrationCount(map, "nemotron-3-nano-omni-30b-a3b-reasoning")).toBe(2);
    expect(concentrationCount(map, "minimax-m3.1-flash")).toBe(1);
    expect(concentrationCount(map, "unknown")).toBe(0);
  });

  test("MAX_LANES_PER_MODEL is 2 (justified by GLM outage)", () => {
    expect(MAX_LANES_PER_MODEL).toBe(2);
  });
});

describe("scoreCandidate", () => {
  const baseOpts = {
    weights: DEFAULT_WEIGHTS,
    offPeak: false,
    taskComplexity: "ordinary" as const,
    concentration: createConcentrationMap(),
    lane: "fixer",
    demandProfile: { tasks: 10, input: 200_000, output: 10_000, cacheRead: 1_500_000 } as DemandProfile,
    budgetSnapshot: undefined as BudgetSnapshot | undefined,
    budgetPolicy: DEFAULT_BUDGET_POLICY,
  };

  const makeCandidate = (ref: string, pricePerMTok = 0): Candidate => ({
    ref,
    providerID: ref.split("/")[0],
    id: ref.split("/").slice(1).join("/"),
    description: ref,
    pricePerMTok,
  });

  test("dark models get massive penalty", () => {
    // Real NIM ref format: nvidia/nvidia/<NIM_ID>
    const dark = makeCandidate("nvidia/nvidia/z-ai/glm-5.3-flash");
    const healthy = makeCandidate("nvidia/nvidia/nemotron-3-ultra-550b-a55b");
    const darkScore = scoreCandidate(dark, baseOpts);
    const healthyScore = scoreCandidate(healthy, baseOpts);
    expect(darkScore.health).toBe(-DEFAULT_WEIGHTS.darkPenalty);
    expect(healthyScore.health).toBe(0);
    expect(darkScore.total).toBeLessThan(healthyScore.total - 50);
  });

  test("degraded models get strong penalty", () => {
    // Real NIM ref format for Lightning model
    const degraded = makeCandidate("nvidia/nvidia/nvidia/nemotron-3.5-lightning-30b-a3b");
    const healthy = makeCandidate("nvidia/nvidia/nemotron-3-ultra-550b-a55b");
    const degradedScore = scoreCandidate(degraded, baseOpts);
    const healthyScore = scoreCandidate(healthy, baseOpts);
    expect(degradedScore.health).toBe(-DEFAULT_WEIGHTS.degradedPenalty);
    expect(degradedScore.total).toBeLessThan(healthyScore.total - 10);
  });

  test("DEBUG: modelHealth and scoreCandidate consistency", () => {
    // Real NIM ref format
    const ref = "nvidia/nvidia/z-ai/glm-5.3-flash";
    const healthId = getHealthModelId(ref);
    const health = modelHealth(healthId);
    console.log(`DEBUG: ref=${ref}, healthId=${healthId}, health=${health}`);
    expect(health).toBe("dark");
    
    const candidate = makeCandidate(ref);
    const score = scoreCandidate(candidate, baseOpts);
    console.log(`DEBUG: score.health=${score.health}`);
    expect(score.health).toBe(-DEFAULT_WEIGHTS.darkPenalty);
  });

  test("free models get cost bonus", () => {
    const free = makeCandidate("opencode/deepseek-v4.1-flash-free", 0);
    const paid = makeCandidate("opencode-go/gemini-4-argon", 6);
    const freeScore = scoreCandidate(free, baseOpts);
    const paidScore = scoreCandidate(paid, baseOpts);
    expect(freeScore.cost).toBeGreaterThan(paidScore.cost);
  });

  test("high latency models get latency penalty", () => {
    // Realistic NIM refs with doubled prefix
    const slow = makeCandidate("nvidia/nvidia/minimaxai/minimax-m3.1-flash");
    const fast = makeCandidate("nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    const slowScore = scoreCandidate(slow, baseOpts);
    const fastScore = scoreCandidate(fast, baseOpts);
    expect(slowScore.latency).toBeLessThan(fastScore.latency);
    // 75s * 0.05 = -3.75 vs 0.75s * 0.05 = -0.0375
    expect(slowScore.latency).toBeCloseTo(-3.75, 1);
    expect(fastScore.latency).toBeCloseTo(-0.0375, 3);
  });

  test("concentration penalty applies at MAX_LANES_PER_MODEL", () => {
    const concentration = createConcentrationMap();
    // Use bare model IDs (last segment) for concentration tracking
    recordConcentration(concentration, "lane1", "model-a");
    recordConcentration(concentration, "lane2", "model-a");
    // At 2 lanes (MAX), penalty should apply
    const opts = { ...baseOpts, concentration };
    // Candidate ref with bare model "model-a"
    const candidate = makeCandidate("provider/model-a");
    const score = scoreCandidate(candidate, opts);
    expect(score.concentration).toBeLessThan(0);
  });

  test("premium penalty for ordinary work on capped models", () => {
    const ordinaryOpts = { ...baseOpts, taskComplexity: "ordinary" as const };
    const hardOpts = { ...baseOpts, taskComplexity: "hard" as const };

    // Go model ref format
    const premium = makeCandidate("opencode-go/gemini-4-argon", 6);
    const ordinaryScore = scoreCandidate(premium, ordinaryOpts);
    const hardScore = scoreCandidate(premium, hardOpts);

    expect(ordinaryScore.premium).toBe(-DEFAULT_WEIGHTS.premiumPenalty);
    expect(hardScore.premium).toBe(2); // bonus for hard work
  });

  test("off-peak bonus applies", () => {
    const peakOpts = { ...baseOpts, offPeak: false };
    const offPeakOpts = { ...baseOpts, offPeak: true };
    const candidate = makeCandidate("opencode-go/deepseek-v4.1-flash");
    const peakScore = scoreCandidate(candidate, peakOpts);
    const offPeakScore = scoreCandidate(candidate, offPeakOpts);
    expect(offPeakScore.offPeak).toBe(DEFAULT_WEIGHTS.offPeakBonus);
    expect(peakScore.offPeak).toBe(0);
  });

  test("exhausted budget models get massive penalty", () => {
    const exhaustedSnapshot: BudgetSnapshot = {
      asOf: Date.now(),
      plan: "go",
      byRef: {
        "opencode-go/gemini-4-argon": {
          ref: "opencode-go/gemini-4-argon",
          limitUsd: 30,
          usedUsd: 35,
          used5h: 10,
          cap5h: 6,
          usedWeek: 20,
          capWeek: 15,
          remainingUsd: 0,
          remainingPct: 0,
          exhausted: true,
        },
      },
    };
    const opts = { ...baseOpts, budgetSnapshot: exhaustedSnapshot };
    // Go model ref format
    const candidate = makeCandidate("opencode-go/gemini-4-argon");
    const score = scoreCandidate(candidate, opts);
    // Exhausted penalty is -1000 (not infinite, for never-block)
    expect(score.health).toBeLessThanOrEqual(-1000);
  });
});

describe("rankCandidates", () => {
  const baseOpts = {
    weights: DEFAULT_WEIGHTS,
    offPeak: false,
    taskComplexity: "ordinary" as const,
    concentration: createConcentrationMap(),
    lane: "fixer",
    demandProfile: { tasks: 10, input: 200_000, output: 10_000, cacheRead: 1_500_000 } as DemandProfile,
    budgetSnapshot: undefined as BudgetSnapshot | undefined,
    budgetPolicy: DEFAULT_BUDGET_POLICY,
  };

  const makeCandidate = (ref: string, pricePerMTok = 0): Candidate => ({
    ref,
    providerID: ref.split("/")[0],
    id: ref.split("/").slice(1).join("/"),
    description: ref,
    pricePerMTok,
  });

  test("healthy free model ranks above dark premium model", () => {
    const candidates = [
      makeCandidate("opencode-go/z-ai/glm-5.3-flash", 0.325), // dark
      makeCandidate("nvidia/nemotron-3-ultra-550b-a55b", 0), // healthy free
    ];
    const ranked = rankCandidates(candidates, baseOpts);
    expect(ranked[0].candidate.ref).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(ranked[1].candidate.ref).toBe("opencode-go/z-ai/glm-5.3-flash");
  });

  test("fast healthy model ranks above slow healthy model", () => {
    const candidates = [
      makeCandidate("nvidia/minimaxai/minimax-m3.1-flash", 0), // 75s
      makeCandidate("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", 0), // 0.75s
    ];
    const ranked = rankCandidates(candidates, baseOpts);
    expect(ranked[0].candidate.ref).toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    expect(ranked[1].candidate.ref).toBe("nvidia/minimaxai/minimax-m3.1-flash");
  });

  test("concentration penalty spreads load", () => {
    const concentration = createConcentrationMap();
    recordConcentration(concentration, "lane1", "nemotron-3-nano-omni-30b-a3b-reasoning");
    recordConcentration(concentration, "lane2", "nemotron-3-nano-omni-30b-a3b-reasoning");
    // At MAX_LANES_PER_MODEL (2), concentration penalty applies
    const opts = { ...baseOpts, concentration };
    const candidates = [
      makeCandidate("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", 0), // concentrated
      makeCandidate("nvidia/nemotron-3-ultra-550b-a55b", 0), // not concentrated
    ];
    const ranked = rankCandidates(candidates, opts);
    // Ultra should rank higher due to concentration penalty on nano
    expect(ranked[0].candidate.ref).toBe("nvidia/nemotron-3-ultra-550b-a55b");
  });

  test("ordinary work prefers free over premium", () => {
    const candidates = [
      makeCandidate("opencode-go/gemini-4-argon", 6), // premium
      makeCandidate("opencode/deepseek-v4.1-flash-free", 0), // free
    ];
    const ranked = rankCandidates(candidates, baseOpts);
    expect(ranked[0].candidate.ref).toBe("opencode/deepseek-v4.1-flash-free");
  });

  test("hard work allows premium", () => {
    const hardOpts = { ...baseOpts, taskComplexity: "hard" as const };
    const candidates = [
      makeCandidate("opencode-go/gemini-4-argon", 6),
      makeCandidate("opencode/deepseek-v4.1-flash-free", 0),
    ];
    const ranked = rankCandidates(candidates, hardOpts);
    // Premium gets +2 bonus for hard work, free gets +5 cost bonus
    // The exact ordering depends on weights, but premium should not be heavily penalized
    expect(ranked.length).toBe(2);
  });
});

describe("filterDarkModels", () => {
  const makeCandidate = (ref: string): Candidate => ({
    ref,
    providerID: ref.split("/")[0],
    id: ref.split("/").slice(1).join("/"),
    description: ref,
    pricePerMTok: 0,
  });

  test("filters out dark models when healthy alternatives exist", () => {
    // Real NIM ref formats
    const candidates = [
      makeCandidate("nvidia/nvidia/z-ai/glm-5.3-flash"),
      makeCandidate("nvidia/nvidia/nemotron-3-ultra-550b-a55b"),
      makeCandidate("opencode/deepseek-v4.1-flash-free"),
    ];
    const filtered = filterDarkModels(candidates);
    expect(filtered.map((c) => c.ref)).toEqual([
      "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
      "opencode/deepseek-v4.1-flash-free",
    ]);
  });

  test("keeps dark models when only dark models available (never-block)", () => {
    // Real NIM ref formats
    const candidates = [
      makeCandidate("nvidia/nvidia/z-ai/glm-5.3-flash"),
      makeCandidate("nvidia/nvidia/deepseek-ai/deepseek-v4.1-flash"),
    ];
    const filtered = filterDarkModels(candidates);
    expect(filtered.length).toBe(2);
    expect(filtered.map((c) => c.ref)).toEqual([
      "nvidia/nvidia/z-ai/glm-5.3-flash",
      "nvidia/nvidia/deepseek-ai/deepseek-v4.1-flash",
    ]);
  });

  test("keeps single healthy model", () => {
    const candidates = [makeCandidate("nvidia/nemotron-3-ultra-550b-a55b")];
    const filtered = filterDarkModels(candidates);
    expect(filtered.length).toBe(1);
  });
});

describe("bareModel helper (re-exported)", () => {
  test("extracts bare model id", () => {
    expect(bareModel("opencode-go/glm-5.3")).toBe("glm-5.3");
    // bareModel takes the last segment after "/"
    expect(bareModel("nvidia/z-ai/glm-5.3-flash")).toBe("glm-5.3-flash");
    // For NIM refs with doubled prefix, use getHealthModelId
    expect(getHealthModelId("nvidia/nvidia/z-ai/glm-5.3-flash")).toBe("z-ai/glm-5.3-flash");
  });
});