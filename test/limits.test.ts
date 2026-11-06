import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bareModel,
  budgetFor,
  budgetNote,
  budgetSnapshot,
  budgetTight,
  costOf,
  describeBudget,
  FIVE_HOURS_MS,
  monthStartUtc,
  MODEL_PRICES,
  partitionByBudget,
  PLAN_LIMITS,
  PLAN_IDS,
  planEntry,
  readUsageByModel,
  resetBudgetCache,
  resolveBudgetPolicy,
  windowCap,
} from "../src/limits";
import { buildQuestions } from "../src/pick";
import { formatPickFooter } from "../src/tool";
import { DEFAULT_BUDGET_POLICY } from "../src/limits";
import type { BudgetSnapshot } from "../src/types";

/** Windows keeps the sqlite handle alive for a moment after close(). */
function dropDb(path: string): void {
  try {
    rmSync(path, { force: true, maxRetries: 6, retryDelay: 100 });
  } catch {
    // best-effort cleanup of a temp file
  }
}

function makeDb(rows: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-budget-"));
  const path = join(dir, "opencode.db");
  const db = new Database(path, { create: true });
  db.prepare(
    `create table session_v2 (
       id text primary key,
       model text,
       tokens_input integer,
       tokens_output integer,
       tokens_cache_read integer,
       tokens_cache_write integer,
       time_created integer,
       time_updated integer
     )`,
  ).run();
  const stmt = db.prepare(
    `insert into session_v2 (id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(
      String(row.id ?? "ses_x"),
      String(row.model ?? "{}"),
      Number(row.tokens_input ?? 0),
      Number(row.tokens_output ?? 0),
      Number(row.tokens_cache_read ?? 0),
      Number(row.tokens_cache_write ?? 0),
      Number(row.time_created ?? 0),
      Number(row.time_updated ?? 0),
    );
  }
  db.close();
  return path;
}

const goModel = (id: string, variant = "high") =>
  JSON.stringify({ id, providerID: "opencode-go", variant });

describe("plan tables", () => {
  test("every priced model has an allowance on every plan", () => {
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(price.input).toBeGreaterThan(0);
      expect(price.output).toBeGreaterThan(0);
      for (const plan of PLAN_IDS) {
        const entry = planEntry(plan, `opencode-go/${model}`);
        expect(entry, `${plan}/${model} missing`).toBeDefined();
        expect(entry!.limitUsd).toBeGreaterThan(0);
      }
    }
  });

  test("allowances grow with the plan tier", () => {
    for (const model of Object.keys(MODEL_PRICES)) {
      const go = PLAN_LIMITS.go[model];
      const plus = PLAN_LIMITS["go-plus"][model];
      const teams = PLAN_LIMITS["go-teams"][model];
      expect(plus).toBeGreaterThan(go);
      expect(teams).toBeGreaterThan(go);
    }
  });

  test("bareModel and unknown refs", () => {
    expect(bareModel("opencode-go/glm-5.3")).toBe("glm-5.3");
    expect(bareModel("glm-5.3")).toBe("glm-5.3");
    expect(planEntry("go", "nvidia/step-5-preview")).toBeUndefined();
    expect(planEntry("go", "opencode/deepseek-v4.1-flash-free")).toBeUndefined();
  });
});

describe("cost math", () => {
  test("weights each token bucket by its own price", () => {
    const price = MODEL_PRICES["glm-5.2"];
    const usd = costOf(price, { input: 1e6, output: 0.5e6, cacheRead: 2e6 });
    expect(usd).toBeCloseTo(1.4 + 2.2 + 0.52, 6);
  });

  test("free-ish and negative-free inputs are clamped", () => {
    expect(costOf(MODEL_PRICES["glm-5.2"], { input: -1, output: -1, cacheRead: -1 })).toBe(0);
  });

  test("window caps follow the documented shares", () => {
    expect(windowCap(100, "month")).toBe(100);
    expect(windowCap(100, "week")).toBe(50);
    expect(windowCap(100, "5h")).toBe(20);
  });

  test("month start is the first UTC day", () => {
    const start = new Date(monthStartUtc(Date.UTC(2026, 10, 23, 12, 30)));
    expect(start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("usage aggregation from the session database", () => {
  test("sums usage per model and prices it into the snapshot", async () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0); // Nov 6, 2026
    const path = makeDb([
      // glm-5.2: 1M input, 0.25M output, 1M cached = 1.4 + 1.1 + 0.26 = 2.76
      { id: "a", model: goModel("glm-5.2"), tokens_input: 1e6, tokens_output: 0.25e6, tokens_cache_read: 1e6, time_updated: now },
      // same model again: total 3.76
      { id: "b", model: goModel("glm-5.2", "max"), tokens_input: 1e6, tokens_output: 0.25e6, tokens_cache_read: 1e6, time_updated: now },
      // a non-Go model: tracked in usage but never capped
      { id: "c", model: JSON.stringify({ id: "glm-5.3", providerID: "nvidia" }), tokens_input: 5e6, time_updated: now },
      // old usage outside the month window
      { id: "d", model: goModel("glm-5.2"), tokens_input: 9e6, time_updated: now - 40 * 24 * 3600_000 },
    ]);
    resetBudgetCache();
    const snapshot = await budgetSnapshot({
      plan: "go",
      now,
      ttlMs: 0,
      dbPath: path,
    });
    dropDb(path);

    const glm = budgetFor(snapshot, "opencode-go/glm-5.2")!;
    expect(glm.limitUsd).toBe(60);
    // two in-window rows: 1.4 + 1.1 + 0.26 = 2.76 each
    expect(glm.usedUsd).toBeCloseTo(5.52, 6);
    expect(glm.remainingUsd).toBeCloseTo(54.48, 6);
    expect(glm.remainingPct).toBeCloseTo(54.48 / 60, 6);
    expect(glm.exhausted).toBe(false);

    // free/unknown-capped models are absent from the snapshot
    expect(budgetFor(snapshot, "opencode/glm-5.3-flash-free")).toBeUndefined();
    expect(budgetFor(snapshot, "nvidia/glm-5.3")).toBeUndefined();
  });

  test("exhaustion marks the model and respects the 5h window", async () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    // glm-5.3 has a $15 cap; burn $20 inside the 5h window
    const path = makeDb([
      { id: "a", model: goModel("glm-5.3"), tokens_input: 10e6, tokens_output: 2e6, tokens_cache_read: 0, time_updated: now - 1000 },
    ]);
    resetBudgetCache();
    const snapshot = await budgetSnapshot({ plan: "go", now, ttlMs: 0, dbPath: path });
    dropDb(path);
    const info = budgetFor(snapshot, "opencode-go/glm-5.3")!;
    expect(info.usedUsd).toBeGreaterThanOrEqual(15);
    expect(info.exhausted).toBe(true);
    expect(describeBudget(info)).toContain("exhausted");
  });

  test("5h window boundary separates recent from stale usage", async () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const path = makeDb([
      { id: "recent", model: goModel("kimi-k3"), tokens_input: 1e6, time_updated: now - 60_000 },
      { id: "stale", model: goModel("kimi-k3"), tokens_input: 1e6, time_updated: now - FIVE_HOURS_MS - 60_000 },
    ]);
    const recent = await readUsageByModel("5h", path, now);
    const month = await readUsageByModel("month", path, now);
    const week = await readUsageByModel("week", path, now);
    dropDb(path);
    expect(recent["kimi-k3"].input).toBe(1e6);
    expect(recent["kimi-k3"].sessions).toBe(1);
    expect(week["kimi-k3"].input).toBe(2e6);
    expect(month["kimi-k3"].input).toBe(2e6);
  });

  test("a missing database is not an error", async () => {
    const usage = await readUsageByModel("month", join(tmpdir(), "definitely-not-here.db"));
    expect(usage).toEqual({});
    resetBudgetCache();
    const snapshot = await budgetSnapshot({ plan: "go", ttlMs: 0, dbPath: join(tmpdir(), "nope.db") });
    expect(Object.keys(snapshot.byRef).length).toBeGreaterThan(0);
  });
});

describe("tightness and partitioning", () => {
  const snapshot: BudgetSnapshot = {
    asOf: 0,
    plan: "go",
    byRef: {
      "opencode-go/glm-5.2": {
        ref: "opencode-go/glm-5.2",
        limitUsd: 60,
        usedUsd: 59,
        used5h: 1,
        cap5h: 12,
        usedWeek: 59,
        capWeek: 30,
        remainingUsd: 1,
        remainingPct: 1 / 60,
        exhausted: false,
      },
      "opencode-go/deepseek-v4.1-flash": {
        ref: "opencode-go/deepseek-v4.1-flash",
        limitUsd: 100,
        usedUsd: 5,
        used5h: 1,
        cap5h: 20,
        usedWeek: 5,
        capWeek: 50,
        remainingUsd: 95,
        remainingPct: 0.95,
        exhausted: false,
      },
      "opencode-go/glm-5.3": {
        ref: "opencode-go/glm-5.3",
        limitUsd: 15,
        usedUsd: 20,
        used5h: 6,
        cap5h: 3,
        usedWeek: 20,
        capWeek: 7.5,
        remainingUsd: 0,
        remainingPct: 0,
        exhausted: true,
      },
    },
  };
  const policy = { ...DEFAULT_BUDGET_POLICY };

  test("tight = below dollar floor, below pct floor, or inside a window cap", () => {
    expect(budgetTight(budgetFor(snapshot, "opencode-go/glm-5.2"), policy)).toBe(true);
    expect(budgetTight(budgetFor(snapshot, "opencode-go/deepseek-v4.1-flash"), policy)).toBe(false);
    expect(budgetTight(budgetFor(snapshot, "opencode-go/glm-5.3"), policy)).toBe(true);
    // unknown budget (free model, other provider) is never tight
    expect(budgetTight(undefined, policy)).toBe(false);
    // disabling the policy makes everything available
    expect(budgetTight(budgetFor(snapshot, "opencode-go/glm-5.2"), { ...policy, enabled: false })).toBe(false);
  });

  test("partition keeps unknown-budget models in the preferred set", () => {
    const items = [
      { ref: "opencode-go/glm-5.2" },
      { ref: "opencode-go/deepseek-v4.1-flash" },
      { ref: "opencode-go/glm-5.3" },
      { ref: "opencode/beam-free" },
    ];
    const { preferred, tight } = partitionByBudget(items, snapshot, policy);
    expect(preferred.map((i) => i.ref)).toEqual([
      "opencode-go/deepseek-v4.1-flash",
      "opencode/beam-free",
    ]);
    expect(tight.map((i) => i.ref)).toEqual([
      "opencode-go/glm-5.2",
      "opencode-go/glm-5.3",
    ]);
  });

  test("without a snapshot everything stays preferred", () => {
    const { preferred, tight } = partitionByBudget([{ ref: "x" }], undefined, policy);
    expect(preferred).toEqual([{ ref: "x" }]);
    expect(tight).toEqual([]);
  });
});

describe("presentation", () => {
  test("budget note and footer text", () => {
    const info = {
      ref: "opencode-go/glm-5.2",
      limitUsd: 60,
      usedUsd: 17.695,
      used5h: 0,
      cap5h: 12,
      usedWeek: 1,
      capWeek: 30,
      remainingUsd: 42.305,
      remainingPct: 0.705,
      exhausted: false,
    };
    expect(budgetNote(info)).toBe(
      "$42.30/$60 left this month ($17.70 used of $60/mo)",
    );
    const footer = formatPickFooter(
      { ref: "opencode-go/glm-5.2", probability: 0.77, backend: "systemone:jev-1.13-free" },
      { lane: "fixer", budget: { remainingUsd: 42.305, limitUsd: 60, exhausted: false } },
    );
    expect(footer).toContain("$42.30/$60 left this month");

    const dead = formatPickFooter({ ref: "x", probability: 0.5, backend: "b" }, {
      budget: { remainingUsd: 0, limitUsd: 15, exhausted: true },
    });
    expect(dead).toContain("plan budget exhausted");
  });

  test("questions carry the budget note and name withheld models", () => {
    const candidates = [
      {
        ref: "opencode-go/deepseek-v4.1-flash",
        providerID: "opencode-go",
        id: "deepseek-v4.1-flash",
        description: "DeepSeek V4.1 Flash",
        pricePerMTok: 0.375,
        budget: {
          ref: "opencode-go/deepseek-v4.1-flash",
          limitUsd: 100,
          usedUsd: 5,
          used5h: 1,
          cap5h: 20,
          usedWeek: 5,
          capWeek: 50,
          remainingUsd: 95,
          remainingPct: 0.95,
          exhausted: false,
        },
      },
    ];
    const q: any = buildQuestions(candidates, "fixer", {
      "opencode-go/deepseek-v4.1-flash": "$95.00/$100 left",
    }, ["opencode-go/glm-5.2"]);
    expect(q.model.criteria["opencode-go/deepseek-v4.1-flash"]).toContain("$95.00/$100 left");
    expect(q.model.instructions).toContain("remaining plan budget");
    expect(q.model.instructions).toContain("nearly exhausted: opencode-go/glm-5.2");
  });
});

describe("policy resolution", () => {
  test("TUI overrides win and junk falls back", () => {
    const base = { ...DEFAULT_BUDGET_POLICY };
    expect(resolveBudgetPolicy(base, { plan: "go-plus", floorUsd: 2 })).toEqual({
      enabled: true,
      plan: "go-plus",
      floorUsd: 2,
      floorPct: base.floorPct,
      windowAware: true,
    });
    const partial = resolveBudgetPolicy(base, { plan: "nope", floorUsd: -3, windowAware: false });
    expect(partial.plan).toBe("go");
    expect(partial.floorUsd).toBe(base.floorUsd);
    expect(partial.windowAware).toBe(false);
    expect(resolveBudgetPolicy(base, undefined)).toEqual(base);
  });
});
