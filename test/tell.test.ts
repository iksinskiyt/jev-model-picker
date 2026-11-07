import { expect, test } from "bun:test";
import {
  formatSubstitution,
  summarizeSubstitutions,
  substitutionFromDecision,
} from "../src/tell";
import { BridgeDecision } from "../src/bridge";

test("formatSubstitution produces the canonical substitution line", () => {
  const s: Substitution = {
    lane: "explorer",
    from: "nvidia/z-ai/glm-5.3-flash",
    to: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b",
    reason: "deep bucket, cheap per task",
    probability: 0.82,
    source: "tool-hook",
    ts: Date.now(),
  };
  const line = formatSubstitution(s);
  expect(line).toContain("JEV · explorer · SUBSTITUTED");
  // to ref gets truncated to 30 chars + "…" — just verify the arrow and reason are present
  expect(line).toContain("→");
  expect(line).toContain("deep bucket, cheap per task");
  expect(line).toContain("82%");
});

test("formatSubstitution handles no-substitution (preset-kept) distinctly", () => {
  const s: Substitution = {
    lane: "fixer",
    from: "?",
    to: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b",
    reason: "no pick — pin kept",
    source: "preset-kept",
  };
  const line = formatSubstitution(s);
  expect(line).toContain("JEV · fixer · PIN KEPT");
  expect(line).not.toContain("SUBSTITUTED");
  expect(line).not.toContain("→");
});

test("formatSubstitution degrades gracefully on malformed input", () => {
  const bad: Substitution = {
    lane: "",
    from: "",
    to: "",
    reason: "",
    source: "tool-hook" as const,
  } as any;
  const line = formatSubstitution(bad);
  // Should never throw; degrade to a plain line
  expect(line).toBeDefined();
  expect(line).toContain("JEV");
});

test("formatSubstitution truncates long refs safely", () => {
  const s: Substitution = {
    lane: "oracle",
    from: "a-very-long-model-identifier-that-exceeds-thirty-characters-xyz",
    to: "another-very-long-model-identifier-that-exceeds-thirty-characters-abc",
    reason: "test",
    probability: 0.9,
    source: "tool-hook",
  };
  const line = formatSubstitution(s);
  // Truncated refs should not break the line
  expect(line).toMatch(/→/);
  // The "…" truncation marker should appear for long refs
  expect(line).toContain("…");
});

test("substitutionFromDecision creates substitution when model differs from default", () => {
  const decision: BridgeDecision = {
    ts: Date.now(),
    sessionID: "ses_001",
    model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b",
    defaultModel: "nvidia/z-ai/glm-5.3-flash",
    probability: 0.82,
    margin: 0.15,
    reason: "deep bucket, cheap per task",
    // The decision backend is what marks the session layer, matching what
    // src/sessions.ts actually records.
    backend: "session-layer",
    lane: "explorer",
    task: "analyze this code",
    pickedPrice: 0.002,
    defaultPrice: 0.015,
  };
  const sub = substitutionFromDecision(decision);
  expect(sub.lane).toBe("explorer");
  expect(sub.from).toBe("nvidia/z-ai/glm-5.3-flash");
  expect(sub.to).toBe("nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b");
  expect(sub.reason).toBe("deep bucket, cheap per task");
  expect(sub.probability).toBe(0.82);
  // backend marks the session layer, not the presence of a sessionID
  expect(sub.source).toBe("session-layer");
  expect(sub.sessionID).toBe("ses_001");
  expect(sub.ts).toBeDefined();
});

test("substitutionFromDecision creates preset-kept when models match", () => {
  const decision: BridgeDecision = {
    ts: Date.now(),
    sessionID: "",
    model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b",
    defaultModel: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b",
    probability: 1,
    margin: 0,
    reason: "match",
    backend: "systemone",
    lane: "fixer",
    task: "task",
    pickedPrice: 0.005,
    defaultPrice: 0.005,
  };
  const sub = substitutionFromDecision(decision, "fixer");
  expect(sub.source).toBe("preset-kept");
  expect(sub.from).toBe("nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b");
  expect(sub.to).toBe("nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b");
});

test("substitutionFromDecision keeps the lane name, never a model ref", () => {
  const decision: BridgeDecision = {
    ts: Date.now(),
    sessionID: "ses_1",
    model: "opencode/c",
    defaultModel: "opencode/a",
    probability: 0.7,
    margin: 0.3,
    reason: "cheaper",
    backend: "session-layer",
    lane: "librarian",
    task: "digest",
    pickedPrice: 0,
    defaultPrice: 6,
  };
  // The signature takes only the decision: a "lane pin" is a model ref and
  // must never end up in the lane field.
  const sub = substitutionFromDecision(decision);
  expect(sub.lane).toBe("librarian");
  expect(sub.from).toBe("opencode/a");
  expect(sub.to).toBe("opencode/c");
  expect(sub.source).toBe("session-layer");
});

test("summarizeSubstitutions with empty list", () => {
  expect(summarizeSubstitutions([])).toBe("No substitutions recorded.");
});

test("sidebar tell pipeline: session subs most-recent-first, max 3, pin-kept excluded", () => {
  const mk = (lane: string, from: string | undefined, ts: number): BridgeDecision => ({
    ts,
    sessionID: "ses_live",
    model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b",
    defaultModel: from,
    probability: 0.8,
    margin: 0.1,
    reason: "cheap",
    backend: "session-layer",
    lane,
    task: "work",
    pickedPrice: 0,
    defaultPrice: 5,
  });
  // Mirrors subsFor() in src/tui/index.tsx: map, drop preset-kept, take 3.
  const decisions = [
    mk("explorer", "nvidia/z-ai/glm-5.3-flash", 4),
    mk("fixer", "nvidia/z-ai/glm-5.3-flash", 3),
    mk("oracle", "nvidia/z-ai/glm-5.3-flash", 2),
    mk("librarian", "nvidia/z-ai/glm-5.3-flash", 1),
    // Pin kept: model equals default — must never render as a substitution.
    {
      ...mk("fixer", "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b", 5),
      model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b-a3b",
    },
  ];
  const subs = decisions
    .map((d) => substitutionFromDecision(d))
    .filter((s) => s.source !== "preset-kept")
    .slice(0, 3);
  expect(subs.length).toBe(3);
  for (const s of subs) {
    const line = formatSubstitution(s);
    expect(line).toContain("SUBSTITUTED");
    expect(line).toContain("→");
  }
  expect(subs.some((s) => s.lane === "librarian")).toBe(false); // 4th, cut off
});

test("summarizeSubstitutions with multiple decisions", () => {
  const decisions: BridgeDecision[] = [
    {
      ts: Date.now() - 100000,
      sessionID: "ses_a",
      model: "a/1",
      defaultModel: "a/0",
      probability: 0.9,
      margin: 0.2,
      reason: "fast",
      backend: "systemone",
      lane: "explorer",
      task: "task a",
      pickedPrice: 0,
      defaultPrice: 5,
    },
    {
      ts: Date.now(),
      sessionID: "ses_b",
      model: "b/1",
      defaultModel: "b/0",
      probability: 0.8,
      margin: 0.1,
      reason: "cheap",
      backend: "systemone",
      lane: "librarian",
      task: "task b",
      pickedPrice: 0,
      defaultPrice: 8,
    },
  ];

  // Convert decisions to substitutions first
  const subs = decisions.map((d) => substitutionFromDecision(d));
  const summary = summarizeSubstitutions(subs);
  expect(summary).toContain("JEV · explorer · SUBSTITUTED");
  expect(summary).toContain("JEV · librarian · SUBSTITUTED");
  expect(summary).toContain("fast");
  expect(summary).toContain("cheap");
});