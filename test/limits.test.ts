import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  averageDemand,
  bareModel,
  budgetFor,
  budgetNote,
  budgetSnapshot,
  budgetTight,
  costOf,
  describeBudget,
  estimateTaskCost,
  FIVE_HOURS_MS,
  monthStartUtc,
  modelCapacity,
  MODEL_PRICES,
  partitionByBudget,
  partitionByTaskFit,
  PLAN_LIMITS,
  PLAN_IDS,
  planEntry,
  readDemandByAgent,
  readUsageByModel,
  remainingCapacity,
  resetBudgetCache,
  resolveBudgetPolicy,
  windowCap,
} from "../src/limits";
import { buildQuestions } from "../src/pick";
import { formatPickFooter } from "../src/tool";
import { DEFAULT_BUDGET_POLICY } from "../src/limits";
import type { BudgetSnapshot, DemandProfile } from "../src/types";

/** Local BudgetInfo factory for the fixture snapshots below. */
function info(
  ref: string,
  limitUsd: number,
  usedUsd: number,
  remainingUsd: number,
  exhausted = false,
) {
  const remainingPct = limitUsd > 0 ? remainingUsd / limitUsd : 1;
  return {
    ref,
    limitUsd,
    usedUsd,
    used5h: usedUsd,
    cap5h: limitUsd * 0.2,
    usedWeek: usedUsd,
    capWeek: limitUsd * 0.5,
    remainingUsd,
    remainingPct,
    exhausted,
  };
}

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
       parent_id text,
       agent text,
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
    `insert into session_v2 (id, parent_id, agent, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(
      String(row.id ?? "ses_x"),
      (row.parent_id as string) ?? null,
      (row.agent as string) ?? null,
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
    const snapshot = await budgetSnapshot({ plan: "go", ttlMs: 0, now: Date.UTC(2026, 10, 6, 12), dbPath: join(tmpdir(), "nope.db") });
    expect(Object.keys(snapshot.byRef).length).toBeGreaterThan(0);
  });

  test("reads per-agent demand, averaged over that agent's sessions", async () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const path = makeDb([
      { id: "f1", parent_id: "p", agent: "fixer", model: goModel("glm-5.2"), tokens_input: 100_000, tokens_output: 4_000, tokens_cache_read: 700_000, time_updated: now },
      { id: "f2", parent_id: "p", agent: "fixer", model: goModel("glm-5.2"), tokens_input: 300_000, tokens_output: 12_000, tokens_cache_read: 1_100_000, time_updated: now },
      { id: "o1", parent_id: "p", agent: "orchestrator", model: goModel("gemini-4-argon"), tokens_input: 10_000, tokens_output: 500, tokens_cache_read: 40_000, time_updated: now },
    ]);
    const demand = await readDemandByAgent(path);
    dropDb(path);
    expect(demand["fixer"]).toEqual({
      tasks: 2,
      input: 200_000,
      output: 8_000,
      cacheRead: 900_000,
    });
    expect(demand["orchestrator"].input).toBe(10_000);
    // Real traffic is cache-read dominated, so cost per task tracks the cached
    // price: GLM-5.2 caches at $0.26 vs Argon's $0.10 makes them near-equal
    // here, while MiMo's $0.0028 is an order of magnitude cheaper.
    const cheap = estimateTaskCost(demand["fixer"], MODEL_PRICES["glm-5.2"]!);
    const dear = estimateTaskCost(demand["fixer"], MODEL_PRICES["gemini-4-argon"]!);
    const flash = estimateTaskCost(demand["fixer"], MODEL_PRICES["mimo-v2.6-flash"]!);
    expect(dear).toBeGreaterThan(flash * 15);
    expect(Math.abs(dear - cheap) / dear).toBeLessThan(0.2);
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
    expect(q.model.instructions).toContain("task this size: opencode-go/glm-5.2");
  });
});

describe("effective capacity", () => {
  test("a $60 bucket buys wildly different token counts by model", () => {
    const muse = modelCapacity({
      limitUsd: 60,
      price: MODEL_PRICES["muse-spark-1.3-contributor"]!,
    });
    const glm = modelCapacity({
      limitUsd: 60,
      price: MODEL_PRICES["glm-5.2"]!,
    });
    // $60 / $0.10 per MTok = 600M input tokens; $60 / $1.40 = ~42.9M
    expect(muse.inputTokens).toBeCloseTo(600e6, -3);
    expect(glm.inputTokens).toBeCloseTo(42.86e6, -4);
    expect(muse.inputTokens / glm.inputTokens).toBeGreaterThan(10);
  });

  test("remaining capacity scales with remaining share", () => {
    const info = {
      ref: "opencode-go/glm-5.2",
      limitUsd: 60,
      usedUsd: 30,
      used5h: 30,
      cap5h: 12,
      usedWeek: 30,
      capWeek: 30,
      remainingUsd: 30,
      remainingPct: 0.5,
      exhausted: false,
    };
    const cap = remainingCapacity(info);
    expect(cap.inputTokens).toBeCloseTo(21.43e6, -4);
  });

  test("premium models drain fastest (the sheet's real ranking)", () => {
    // Argon: $30 cap at the current 50%-off price of $2/MTok in → 15M tokens.
    // The discount ends 2026-11-30, after which this halves to 7.5M.
    const argon = modelCapacity({ limitUsd: 30, price: MODEL_PRICES["gemini-4-argon"]! });
    const deepseek = modelCapacity({ limitUsd: 100, price: MODEL_PRICES["deepseek-v4.1-flash"]! });
    expect(argon.inputTokens).toBeCloseTo(15e6, -5);
    expect(argon.outputTokens).toBeCloseTo(3e6, -5);
    expect(deepseek.inputTokens / argon.inputTokens).toBeGreaterThan(4);
  });
});

describe("task demand and task-fit partitioning", () => {
  // A fixer-shaped task from the real DB: ~200K fresh input, ~1.5M cached
  // re-reads, ~10K output. Cached reads dominate, which is why cost per task
  // tracks the cached-read price, not the headline input price.
  const fixerProfile: DemandProfile = { tasks: 10, input: 200_000, output: 10_000, cacheRead: 1_500_000 };
  const librarianProfile: DemandProfile = { tasks: 40, input: 20_000, output: 2_000, cacheRead: 90_000 };

  test("averages demand across agents when the lane has no history", () => {
    const avg = averageDemand([fixerProfile, librarianProfile])!;
    expect(avg.input).toBeCloseTo((200_000 * 10 + 20_000 * 40) / 50, 3);
    expect(avg.tasks).toBe(50);
    expect(averageDemand([])).toBeUndefined();
  });

  test("cached-read price dominates the real cost of a task", () => {
    const argon = estimateTaskCost(fixerProfile, MODEL_PRICES["gemini-4-argon"]!);
    const mimo = estimateTaskCost(fixerProfile, MODEL_PRICES["mimo-v2.6-flash"]!);
    // MiMo caches at $0.0028/MTok vs Argon's $0.10 — ~30x cheaper per task
    // even though the headline input prices differ by ~14x.
    expect(argon / mimo).toBeGreaterThan(15);
    expect(argon).toBeCloseTo(0.4 + 0.1 + 0.15, 6);
  });

  test("withholding is by task fit: premium models drop out for big tasks", () => {
    // All three sit inside their month/week/5h windows, so the only thing that
    // can push a model out here is the *size* of the task.
    const snapshot: BudgetSnapshot = {
      asOf: 0,
      plan: "go",
      byRef: {
        "opencode-go/gemini-4-argon": {
          ref: "opencode-go/gemini-4-argon",
          limitUsd: 30,
          usedUsd: 15,
          used5h: 1,
          cap5h: 6,
          usedWeek: 2,
          capWeek: 15,
          remainingUsd: 15,
          remainingPct: 0.5,
          exhausted: false,
        },
        "opencode-go/claude-haiku-5-5": {
          ref: "opencode-go/claude-haiku-5-5",
          limitUsd: 15,
          usedUsd: 1,
          used5h: 0.2,
          cap5h: 3,
          usedWeek: 0.5,
          capWeek: 7.5,
          remainingUsd: 14,
          remainingPct: 14 / 15,
          exhausted: false,
        },
        "opencode-go/deepseek-v4.1-flash": {
          ref: "opencode-go/deepseek-v4.1-flash",
          limitUsd: 100,
          usedUsd: 10,
          used5h: 1,
          cap5h: 20,
          usedWeek: 2,
          capWeek: 50,
          remainingUsd: 90,
          remainingPct: 0.9,
          exhausted: false,
        },
      },
    };
    const policy = { ...DEFAULT_BUDGET_POLICY, minTasks: 1 };
    const items = [
      { ref: "opencode-go/gemini-4-argon" },
      { ref: "opencode-go/claude-haiku-5-5" },
      { ref: "opencode-go/deepseek-v4.1-flash" },
    ];
    const { preferred: fix, tasksLeft } = partitionByTaskFit(items, snapshot, policy, fixerProfile);
    // deepseek absorbs thousands of fixer tasks; argon tens; claude hundreds
    expect(tasksLeft.get("opencode-go/deepseek-v4.1-flash")!).toBeGreaterThan(1000);
    expect(tasksLeft.get("opencode-go/gemini-4-argon")!).toBeGreaterThan(10);
    expect(fix.length).toBe(3);

    const { preferred: lib } = partitionByTaskFit(items, snapshot, policy, librarianProfile);
    expect(lib.length).toBe(3);

    // A much larger task (long-horizon work) pushes the premium bucket out
    const huge: DemandProfile = { tasks: 5, input: 10_000_000, output: 200_000, cacheRead: 40_000_000 };
    const { preferred: big, tight } = partitionByTaskFit(items, snapshot, policy, huge);
    expect(tight.map((i) => i.ref)).toContain("opencode-go/gemini-4-argon");
    expect(big.map((i) => i.ref)).toContain("opencode-go/deepseek-v4.1-flash");
    expect(big.map((i) => i.ref)).not.toContain("opencode-go/gemini-4-argon");
  });

  test("notes report tasks left", () => {
    const info = {
      ref: "opencode-go/glm-5.2",
      limitUsd: 60,
      usedUsd: 41,
      used5h: 1,
      cap5h: 12,
      usedWeek: 1,
      capWeek: 30,
      remainingUsd: 19,
      remainingPct: 19 / 60,
      exhausted: false,
    };
    const note = budgetNote(info, 3);
    expect(note).toContain("$19.00/$60 left this month");
    expect(note).toContain("~3 tasks left");
    expect(budgetNote(info, 0)).toContain("cannot absorb another task");
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
      capacityAware: true,
      minTasks: 1,
    });
    const partial = resolveBudgetPolicy(base, { plan: "nope", floorUsd: -3, windowAware: false });
    expect(partial.plan).toBe("go");
    expect(partial.floorUsd).toBe(base.floorUsd);
    expect(partial.windowAware).toBe(false);
    expect(resolveBudgetPolicy(base, undefined)).toEqual(base);
  });
});
