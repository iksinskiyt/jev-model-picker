import { describe, expect, test } from "bun:test";
import {
  qualityByModel,
  qualityByLane,
  flailScore,
  formatQuality,
  outcomeForDecision,
  type TaskOutcome,
} from "../src/outcomes";

// The vocabulary OpenCode actually writes. Measured on a live host: 136 child
// sessions split succeeded 104 / failed 16 / interrupted 6 / null 10.
// `resume_attempts` was 0 on every row and `cost` was 0 everywhere.
function o(
  over: Partial<TaskOutcome> & Pick<TaskOutcome, "sessionID" | "model">,
): TaskOutcome {
  return {
    lane: "fixer",
    outcome: "succeeded",
    resumeAttempts: 0,
    durationMs: 1000,
    tokensInput: 100,
    tokensOutput: 50,
    tokensCacheRead: 5000,
    costUsd: 0,
    ts: 1,
    ...over,
  };
}

describe("outcome normalisation", () => {
  test("maps OpenCode's own vocabulary, not the obvious guess", () => {
    const rows = qualityByModel([
      o({ sessionID: "a", model: "m/x", outcome: "succeeded" }),
      o({ sessionID: "b", model: "m/x", outcome: "failed" }),
      o({ sessionID: "c", model: "m/x", outcome: "interrupted" }),
    ]);
    expect(rows[0].solved).toBe(1);
    expect(rows[0].failed).toBe(1);
    expect(rows[0].interrupted).toBe(1);
    expect(rows[0].unknown).toBe(0);
    expect(rows[0].solvedRate).toBeCloseTo(1 / 3);
  });

  test("an unset idle_outcome is unknown, not a failure", () => {
    const rows = qualityByModel([
      o({ sessionID: "a", model: "m/x", outcome: "unknown" }),
    ]);
    expect(rows[0].unknown).toBe(1);
    expect(rows[0].failed).toBe(0);
  });
});

describe("qualityByModel", () => {
  test("a model that never solves has INFINITE cost per solved task", () => {
    const rows = qualityByModel([
      o({ sessionID: "a", model: "bad/x", outcome: "failed", tokensCacheRead: 9_000_000 }),
      o({ sessionID: "b", model: "bad/x", outcome: "failed" }),
    ]);
    expect(rows[0].solved).toBe(0);
    expect(rows[0].tokensPerSolved).toBe(Infinity);
    // It must not read as free.
    expect(Number.isFinite(rows[0].costPerSolvedUsd)).toBe(false);
  });

  test("wasted tokens per attempt averages over ALL attempts", () => {
    const rows = qualityByModel([
      o({ sessionID: "a", model: "m/x", outcome: "succeeded", tokensCacheRead: 100 }),
      o({ sessionID: "b", model: "m/x", outcome: "failed", tokensCacheRead: 4000 }),
    ]);
    // The failure burned 4000 + 100 + 50 = 4150, averaged over BOTH attempts
    // (the metric is average waste per task routed here, not per failure).
    expect(rows[0].wastedTokensPerAttempt).toBe(2075);
    expect(rows[0].solvedRate).toBe(0.5);
  });

  test("ranks by solved rate first", () => {
    const rows = qualityByModel([
      o({ sessionID: "a", model: "low/x", outcome: "failed" }),
      o({ sessionID: "b", model: "high/x", outcome: "succeeded" }),
    ]);
    expect(rows[0].ref).toBe("high/x");
  });

  test("medianSeconds comes from durationMs", () => {
    const rows = qualityByModel([
      o({ sessionID: "a", model: "m/x", durationMs: 1000 }),
      o({ sessionID: "b", model: "m/x", durationMs: 3000 }),
    ]);
    expect(rows[0].medianSeconds).toBeGreaterThan(1);
    expect(rows[0].medianSeconds).toBeLessThan(3);
  });
});

describe("flailScore", () => {
  test("zero for a model with no history — it is not penalised for being new", () => {
    expect(flailScore([], "never/seen")).toBe(0);
  });

  test("zero for a model that has only succeeded", () => {
    const rows = [
      o({ sessionID: "a", model: "m/x", outcome: "succeeded" }),
      o({ sessionID: "b", model: "m/x", outcome: "succeeded" }),
    ];
    expect(flailScore(rows, "m/x")).toBe(0);
  });

  test("positive and capped when a model burns tokens failing", () => {
    const rows = [
      o({ sessionID: "a", model: "m/x", outcome: "failed", tokensCacheRead: 9_000_000 }),
      o({ sessionID: "b", model: "m/x", outcome: "failed", tokensCacheRead: 9_000_000 }),
    ];
    const s = flailScore(rows, "m/x");
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThanOrEqual(5);
  });

  test("higher for a worse record", () => {
    const mediocre = [
      o({ sessionID: "a", model: "m/x", outcome: "succeeded" }),
      o({ sessionID: "b", model: "m/x", outcome: "failed", tokensCacheRead: 1_000_000 }),
    ];
    const terrible = [
      o({ sessionID: "a", model: "m/x", outcome: "failed", tokensCacheRead: 1_000_000 }),
      o({ sessionID: "b", model: "m/x", outcome: "failed", tokensCacheRead: 1_000_000 }),
    ];
    expect(flailScore(terrible, "m/x")).toBeGreaterThan(flailScore(mediocre, "m/x"));
  });
});

describe("formatQuality", () => {
  test("empty input says so, never throws", () => {
    expect(formatQuality([])).toBe("no delegated tasks measured yet");
  });

  test("a never-solved model reads as 'never solved', not free", () => {
    const rows = qualityByModel([
      o({ sessionID: "a", model: "bad/x", outcome: "failed", tokensCacheRead: 2_000_000 }),
    ]);
    const text = formatQuality(rows);
    expect(text).toContain("never solved");
    expect(text).toContain("bad/x");
  });

  test("a malformed row degrades instead of throwing", () => {
    // @ts-expect-error deliberately broken input
    expect(formatQuality([{ ref: null }])).toBe("quality data unavailable");
  });
});

describe("qualityByLane", () => {
  test("groups by lane instead of model", () => {
    const rows = qualityByLane([
      o({ sessionID: "a", lane: "fixer", model: "m/a", outcome: "succeeded" }),
      o({ sessionID: "b", lane: "fixer", model: "m/b", outcome: "failed" }),
      o({ sessionID: "c", lane: "oracle", model: "m/a", outcome: "succeeded" }),
    ]);
    const fixer = rows.find((r) => r.ref === "fixer");
    const oracle = rows.find((r) => r.ref === "oracle");
    expect(fixer?.attempts).toBe(2);
    expect(oracle?.solvedRate).toBe(1);
  });
});

describe("outcomeForDecision", () => {
  test("joins a bridge decision back to its measured outcome", () => {
    const rows = [
      o({ sessionID: "ses_1", model: "m/x" }),
      o({ sessionID: "ses_2", model: "m/y", outcome: "failed" }),
    ];
    const decision = {
      ts: 1,
      sessionID: "ses_2",
      model: "m/y",
      probability: 0.5,
      margin: 0.1,
      reason: "",
      backend: "b",
      lane: "fixer",
      task: "t",
      pickedPrice: 0,
      defaultPrice: 0,
    };
    const found = outcomeForDecision(rows, decision);
    expect(found?.sessionID).toBe("ses_2");
    expect(found?.outcome).toBe("failed");
  });

  test("returns undefined when the decision never landed", () => {
    const rows = [o({ sessionID: "other", model: "m/x" })];
    const decision = {
      ts: 1, sessionID: "never", model: "m/x", probability: 0.5, margin: 0.1,
      reason: "", backend: "b", lane: "fixer", task: "t",
      pickedPrice: 0, defaultPrice: 0,
    };
    expect(outcomeForDecision(rows, decision)).toBeUndefined();
  });
});
