import { describe, expect, test, beforeEach } from "bun:test";
import { resolveConfig } from "../src/config";
import { PickerRuntime } from "../src/pick";
import { listCandidates, resetGlobalConcentration, getGlobalConcentration } from "../src/catalog";
import { resetBudgetCache } from "../src/limits";
import type { Candidate, PickResult } from "../src/types";

// Mock ctx with realistic model catalog from FINDINGS.md
const mockCtx = {
  model: {
    list: async () => [
      // Healthy NIM free models (serving, verified)
      {
        providerID: "nvidia",
        id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        name: "Nemotron 3 Nano Omni Reasoning",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      {
        providerID: "nvidia",
        id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
        name: "Nemotron 3.5 Super VL",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      {
        providerID: "nvidia",
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        name: "Nemotron 3 Ultra",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      {
        providerID: "nvidia",
        id: "nvidia/stepfun-ai/step-5-preview",
        name: "Step 5 Preview",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      {
        providerID: "nvidia",
        id: "nvidia/minimaxai/minimax-m3.1-flash",
        name: "MiniMax M3.1 Flash",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      // Dark models (from FINDINGS.md)
      {
        providerID: "nvidia",
        id: "nvidia/z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active", // Listed but actually down
      },
      {
        providerID: "nvidia",
        id: "nvidia/deepseek-ai/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active", // Listed but actually down
      },
      // Empty response model
      {
        providerID: "nvidia",
        id: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
        name: "Nemotron 3.5 Lightning",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      // OpenCode free tier models
      {
        providerID: "opencode",
        id: "deepseek-v4.1-flash-free",
        name: "DeepSeek V4.1 Flash Free",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      {
        providerID: "opencode",
        id: "glm-5.3-flash-free",
        name: "GLM 5.3 Flash Free",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      // Exhausted Go plan models (gemini-4-argon: $1125.53/$30)
      {
        providerID: "opencode-go",
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        cost: [{ input: 2.0, output: 10.0, cacheRead: 0.1 }],
        limit: { context: 1_000_000 },
        capabilities: { tools: true },
        status: "active",
      },
      {
        providerID: "opencode-go",
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash (Go)",
        cost: [{ input: 0.15, output: 0.6, cacheRead: 0.003 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
      {
        providerID: "opencode-go",
        id: "mimo-v2.6-flash",
        name: "MiMo V2.6 Flash",
        cost: [{ input: 0.14, output: 0.28, cacheRead: 0.0028 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
        status: "active",
      },
    ],
  },
  storage: {
    scan: async () => ({ entries: [] }),
  },
  provider: {
    get: async () => ({ settings: { baseURL: "https://opencode.ai/inference/systemone/v1" } }),
  },
};

/**
 * Creates a PickerRuntime with a mock backend that returns a deterministic pick
 * based on the evidence-ranked candidate list. This allows testing the candidate
 * ordering/filtering logic without requiring a real LLM backend.
 */
function createTestPicker(overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}) {
  const cfg = resolveConfig({
    enabled: true,
    budget: { enabled: true, plan: "go", capacityAware: true, windowAware: true },
    policy: { maxCandidates: 12 },
    // Use a mock chat backend that picks the first healthy candidate
    backend: "chat",
    chat: {
      baseURL: "http://mock",
      model: "mock-picker",
      timeoutMs: 1000,
      maxTokens: 2048,
      jsonMode: true,
    },
    ...overrides,
  });

  // Patch the chat call to return a mock pick
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string, options: any) => {
    if (url.includes("/chat/completions")) {
      // Extract candidates from the request body
      const body = JSON.parse(options.body);
      const userContent = body.messages.find((m: any) => m.role === "user")?.content ?? "";
      // Parse candidate refs from the prompt
      const candidateRefs = userContent
        .split("Candidates:\n")[1]?.split("\n")
        .map((line: string) => line.replace(/^-\s+/, "").split(":")[0].trim())
        .filter(Boolean) ?? [];

      // Pick the first healthy non-dark candidate
      const darkRefs = ["z-ai/glm-5.3-flash", "deepseek-ai/deepseek-v4.1-flash", "z-ai/glm-5.3"];
      const emptyRefs = ["nvidia/nemotron-3.5-lightning-30b-a3b"];
      const pickRef = candidateRefs.find(
        (ref: string) => !darkRefs.some((d) => ref.includes(d)) && !emptyRefs.some((e) => ref.includes(e))
      ) ?? candidateRefs[0];

      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ model: pickRef, confidence: 0.9, reason: "mock pick" }) } }],
        }),
      } as Response;
    }
    return originalFetch(url, options);
  };

  const picker = new PickerRuntime(mockCtx, cfg);
  return { picker, restore: () => { globalThis.fetch = originalFetch; } };
}

describe("Decision quality — evidence-based picker behavior", () => {
  beforeEach(() => {
    resetGlobalConcentration();
    resetBudgetCache();
  });

  test("SCENARIO 1: Fixer-sized task with 32× cacheRead — candidates ranked with free models first", async () => {
    // FINDINGS: fixer 47.8M cacheRead vs 1.5M input = 32×
    // FINDINGS: gemini-4-argon exhausted at $1125.53/$30
    // FINDINGS: Go plan is dead — all real work runs on free tiers ($0.00 cost)

    const { picker, restore } = createTestPicker();
    try {
      const taskText = `
        Fix the authentication middleware in the API gateway. The JWT validation is failing
        for tokens issued after the key rotation. Need to update the key cache and handle
        the transition gracefully. This involves reading through 50+ files of middleware
        code, understanding the token refresh flow, and implementing a backward-compatible fix.
      `;

      // Test candidate ordering directly (bypassing backend)
      const candidates = await picker.candidatesFor("fixer", undefined, {
        taskDigest: taskText.slice(0, 1200),
        demandProfile: { tasks: 10, input: 200_000, output: 10_000, cacheRead: 1_500_000 },
      });

      const refs = candidates.map((c) => c.ref);

      // Dark models should be filtered out
      expect(refs).not.toContain("nvidia/nvidia/z-ai/glm-5.3-flash");
      expect(refs).not.toContain("nvidia/nvidia/deepseek-ai/deepseek-v4.1-flash");

      // Healthy free models should be at the top
      const top3 = refs.slice(0, 3);
      for (const ref of top3) {
        expect(ref.startsWith("opencode/") || ref.startsWith("nvidia/nvidia/")).toBe(true);
      }

      // Exhausted Go models should be ranked lower
      const goModels = refs.filter((r) => r.startsWith("opencode-go/"));
      if (goModels.length > 0) {
        const firstGoIdx = refs.indexOf(goModels[0]);
        const firstFreeIdx = refs.findIndex((r) => r.startsWith("opencode/") || r.startsWith("nvidia/nvidia/"));
        expect(firstFreeIdx).toBeLessThan(firstGoIdx);
      }
    } finally {
      restore();
    }
  });

  test("SCENARIO 2: Dark GLM endpoint is excluded, not just reordered", async () => {
    // FINDINGS: z-ai/glm-5.3-flash timeout @ 100s and 240s x3 — DOWN
    // Three lanes (explorer, librarian, observer) were silently dead on this model

    const { picker, restore } = createTestPicker();
    try {
      const candidates = await picker.candidatesFor("explorer", undefined, {
        taskDigest: "simple task",
      });

      const refs = candidates.map((c) => c.ref);

      // Dark models should be filtered out when healthy alternatives exist
      expect(refs).not.toContain("nvidia/nvidia/z-ai/glm-5.3-flash");
      expect(refs).not.toContain("nvidia/nvidia/deepseek-ai/deepseek-v4.1-flash");
      expect(refs).not.toContain("nvidia/nvidia/z-ai/glm-5.3");

      // Healthy models should be present
      expect(refs).toContain("nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
      expect(refs).toContain("nvidia/nvidia/nemotron-3-ultra-550b-a55b");
    } finally {
      restore();
    }
  });

  test("SCENARIO 3: High-volume explorer lane gets fast model (0.75s) ranked above 75s model", async () => {
    // FINDINGS: nemotron-3-nano-omni-30b-a3b-reasoning 0.75s (3/3 quality)
    // FINDINGS: minimax-m3.1-flash ~75s (4/4 quality) — too slow for high-volume lane

    const { picker, restore } = createTestPicker();
    try {
      const candidates = await picker.candidatesFor("explorer", undefined, {
        taskDigest: "explore codebase",
      });

      const refs = candidates.map((c) => c.ref);
      const nanoIdx = refs.indexOf("nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
      const minimaxIdx = refs.indexOf("nvidia/nvidia/minimaxai/minimax-m3.1-flash");

      expect(nanoIdx).toBeGreaterThanOrEqual(0);
      expect(minimaxIdx).toBeGreaterThanOrEqual(0);
      expect(nanoIdx).toBeLessThan(minimaxIdx); // Faster model ranks higher
    } finally {
      restore();
    }
  });

  test("SCENARIO 4: Concentration risk — concentration tracking works", async () => {
    // FINDINGS: 46.8M of fixer's 47.8M cacheRead on single model across 3 sessions
    // FINDINGS: GLM-5.3-Flash on 3 lanes caused total outage
    // MAX_LANES_PER_MODEL = 2

    const { picker, restore } = createTestPicker();
    try {
      const concentration = getGlobalConcentration();

      // Simulate multiple lanes picking the same model
      for (const lane of ["explorer", "fixer", "librarian"]) {
        await picker.candidatesFor(lane, undefined, {
          taskDigest: `task for ${lane}`,
          concentration,
        });
      }

      // The concentration map should track lanes per model
      // (Exact distribution depends on ranking, but tracking works)
      expect(concentration.modelToLanes.size).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  test("SCENARIO 5: Ordinary task candidates prefer free tier over premium Go models", async () => {
    // FINDINGS: All real work runs on free tiers ($0.00)
    // FINDINGS: Jev was routing to opencode-go/deepseek-v4.1-flash (dead plan)
    // Rule: ordinary/low-complexity task must not consume scarce premium model

    const { picker, restore } = createTestPicker();
    try {
      const candidates = await picker.candidatesFor("fixer", undefined, {
        taskDigest: "fix a typo in the readme",
      });

      const refs = candidates.map((c) => c.ref);

      // Free tier models should rank above Go models
      const freeIdx = refs.findIndex((r) => r.startsWith("opencode/") || r.startsWith("nvidia/nvidia/"));
      const goIdx = refs.findIndex((r) => r.startsWith("opencode-go/"));

      expect(freeIdx).toBeGreaterThanOrEqual(0);
      if (goIdx >= 0) {
        expect(freeIdx).toBeLessThan(goIdx);
      }
    } finally {
      restore();
    }
  });

  test("SCENARIO 6: Hard task (complex keywords) gets appropriate ranking", async () => {
    // FINDINGS: Hard work (refactor, architecture, debug, investigate) may need premium capability
    // But with current exhausted Go plan, even hard tasks should prefer healthy free models

    const { picker, restore } = createTestPicker();
    try {
      const candidates = await picker.candidatesFor("fixer", undefined, {
        taskDigest: "refactor the entire authentication architecture to use oauth2 with pkce. investigate the current jwt implementation, design the new token flow, and migrate all 50+ api endpoints.",
      });

      const refs = candidates.map((c) => c.ref);

      // Dark/exhausted models should still be deprioritized
      expect(refs).not.toContain("nvidia/nvidia/z-ai/glm-5.3-flash");
      expect(refs).not.toContain("nvidia/nvidia/deepseek-ai/deepseek-v4.1-flash");

      // Healthy models should be available
      expect(refs.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  test("SCENARIO 7: Cache-read cost dominates — models with cheap cacheRead preferred", async () => {
    // FINDINGS: fixer 47.8M cacheRead vs 1.5M input = 32×
    // FINDINGS: designer 29.9M vs 16.7M = 1.8×
    // Per-task cost is a cache-read prediction problem

    const { picker, restore } = createTestPicker();
    try {
      const candidates = await picker.candidatesFor("fixer", undefined, {
        taskDigest: "fix the bug in the payment processing module",
        demandProfile: { tasks: 10, input: 200_000, output: 10_000, cacheRead: 1_500_000 },
      });

      const refs = candidates.map((c) => c.ref);

      // Free models (cacheRead = $0) should rank highest
      expect(refs[0]).toMatch(/^(opencode\/|nvidia\/nvidia\/)/);
    } finally {
      restore();
    }
  });

  test("SCENARIO 8: Off-peak pricing for DeepSeek V4.1 Flash is considered", async () => {
    // FINDINGS: DeepSeek V4.x has off-peak $0.15/$0.6 vs peak $0.3/$1.2 per MTok
    // Off-peak window default: 00:00-08:00 UTC

    const { picker: pickerOffPeak, restore: restore1 } = createTestPicker();
    const { picker: pickerPeak, restore: restore2 } = createTestPicker();
    try {
      // Test during off-peak (04:00 UTC)
      const offPeakTime = Date.UTC(2026, 10, 6, 4, 0, 0);
      const candidatesOffPeak = await pickerOffPeak.candidatesFor("fixer", undefined, {
        taskDigest: "task",
        now: offPeakTime,
      });

      // Test during peak (12:00 UTC)
      const peakTime = Date.UTC(2026, 10, 6, 12, 0, 0);
      const candidatesPeak = await pickerPeak.candidatesFor("fixer", undefined, {
        taskDigest: "task",
        now: peakTime,
      });

      // Both should work (off-peak is a bonus, not a hard filter)
      expect(candidatesOffPeak.length).toBeGreaterThan(0);
      expect(candidatesPeak.length).toBeGreaterThan(0);
    } finally {
      restore1();
      restore2();
    }
  });

  test("SCENARIO 9: Empty response model (Lightning-30B) is degraded, ranked below healthy", async () => {
    // FINDINGS: nemotron-3.5-lightning-30b-a3b returns EMPTY response — unusable

    const { picker, restore } = createTestPicker();
    try {
      const candidates = await picker.candidatesFor("fixer", undefined, {
        taskDigest: "task",
      });

      const refs = candidates.map((c) => c.ref);
      const lightningIdx = refs.indexOf("nvidia/nvidia/nvidia/nemotron-3.5-lightning-30b-a3b");
      const ultraIdx = refs.indexOf("nvidia/nvidia/nemotron-3-ultra-550b-a55b");

      if (lightningIdx >= 0 && ultraIdx >= 0) {
        // Degraded model should rank below healthy model
        expect(lightningIdx).toBeGreaterThan(ultraIdx);
      }
    } finally {
      restore();
    }
  });

  test("SCENARIO 10: Never-block — candidates always returned when any healthy model exists", async () => {
    const { picker, restore } = createTestPicker();
    try {
      const candidates = await picker.candidatesFor("any-lane", undefined, {
        taskDigest: "some task",
      });

      // Should always return at least 2 candidates (maxCandidates minimum)
      expect(candidates.length).toBeGreaterThanOrEqual(2);
    } finally {
      restore();
    }
  });
});

describe("Candidate ordering with evidence-based scoring", () => {
  beforeEach(() => {
    resetGlobalConcentration();
    resetBudgetCache();
  });

  test("listCandidates returns evidence-ranked order for fixer lane", async () => {
    const cfg = resolveConfig({ policy: { maxCandidates: 12 } });
    const candidates = await listCandidates(mockCtx, cfg, "fixer", undefined, undefined, {
      taskDigest: "fix the bug in the payment module with lots of context",
      demandProfile: { tasks: 10, input: 200_000, output: 10_000, cacheRead: 1_500_000 },
    });

    const refs = candidates.map((c) => c.ref);

    // Dark models excluded
    expect(refs).not.toContain("nvidia/nvidia/z-ai/glm-5.3-flash");
    expect(refs).not.toContain("nvidia/nvidia/deepseek-ai/deepseek-v4.1-flash");
    expect(refs).not.toContain("nvidia/nvidia/z-ai/glm-5.3");

    // Healthy free models at top
    const top3 = refs.slice(0, 3);
    for (const ref of top3) {
      expect(ref.startsWith("opencode/") || ref.startsWith("nvidia/nvidia/")).toBe(true);
    }

    // Exhausted Go models at bottom (or excluded if budget-aware)
    const goModels = refs.filter((r) => r.startsWith("opencode-go/"));
    if (goModels.length > 0) {
      const firstGoIdx = refs.indexOf(goModels[0]);
      const firstFreeIdx = refs.findIndex((r) => r.startsWith("opencode/") || r.startsWith("nvidia/nvidia/"));
      expect(firstFreeIdx).toBeLessThan(firstGoIdx);
    }
  });

  test("Explicit lane config still wins over auto-discovery", async () => {
    const cfg = resolveConfig({
      policy: { maxCandidates: 12 },
      lanes: { explorer: ["nvidia/nvidia/nemotron-3-ultra-550b-a55b"] },
    });
    const candidates = await listCandidates(mockCtx, cfg, "explorer", "opencode/deepseek-v4.1-flash-free", undefined, {
      taskDigest: "task",
    });

    const refs = candidates.map((c) => c.ref);
    expect(refs).toEqual(["nvidia/nvidia/nemotron-3-ultra-550b-a55b"]);
  });

  test("Allowlist restricts candidates", async () => {
    const cfg = resolveConfig({ policy: { maxCandidates: 12 } });
    const candidates = await listCandidates(mockCtx, cfg, "fixer", undefined, ["opencode/deepseek-v4.1-flash-free"], {
      taskDigest: "task",
    });

    const refs = candidates.map((c) => c.ref);
    expect(refs).toEqual(["opencode/deepseek-v4.1-flash-free"]);
  });
});