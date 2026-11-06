import { expect, test } from "bun:test";
import { appendToolResultText, formatPickFooter, probabilityBar } from "../src/tool";

test("probabilityBar renders filled and empty cells", () => {
  expect(probabilityBar(0, 10)).toBe("░░░░░░░░░░");
  expect(probabilityBar(1, 10)).toBe("██████████");
  expect(probabilityBar(0.5, 10)).toBe("█████░░░░░");
  expect(probabilityBar(-1, 4)).toBe("░░░░");
  expect(probabilityBar(2, 4)).toBe("████");
});

test("formatPickFooter leads with substitution line when model differs from default", () => {
  const footer = formatPickFooter(
    {
      ref: "opencode/deepseek-v4.1-flash-free",
      probability: 0.77,
      margin: 0.72,
      reason: "cost effective",
      backend: "systemone:jev-1.13-free",
      latencyMs: 264,
    },
    { lane: "librarian", defaultModel: "nvidia/x", ratio: 0.25 },
  );
  // Leading with the substitution tell (from src/tell.ts)
  expect(footer).toMatch(/^JEV · librarian · SUBSTITUTED/);
  expect(footer).toContain("77%");
  expect(footer).toContain("cost effective");
  // The lane name appears after "·" in the substitution line
  expect(footer).toContain("librarian");
  // The old "JEV picked" line is replaced by the substitution line
  expect(footer).not.toContain("JEV picked opencode/deepseek-v4.1-flash-free");
  expect(footer).toContain("systemone:jev-1.13-free");
  expect(footer).toContain("264ms");
});

test("formatPickFooter preserves existing format when pin is kept", () => {
  // When ref equals defaultModel, no substitution → existing format
  const footer = formatPickFooter(
    {
      ref: "nvidia/x",
      probability: 0.5,
      reason: "default choice",
      backend: "systemone:default",
      latencyMs: 100,
    },
    { lane: "explorer", defaultModel: "nvidia/x" },
  );
  // Existing format is preserved — leads with "---" and "JEV picked"
  expect(footer).toContain("---");
  expect(footer).toContain("JEV picked nvidia/x");
  expect(footer).toContain("50.0%");
  // Lane appears in the details section
  expect(footer).toContain("explorer");
  expect(footer).toContain("default nvidia/x");
});

test("appendToolResultText appends to a string content", () => {
  const result: any = { content: "subagent output" };
  appendToolResultText(result, "---\nJEV bar");
  expect(result.content).toBe("subagent output\n\n---\nJEV bar");
});

test("appendToolResultText appends a text content item to arrays", () => {
  const result: any = { content: [{ type: "text", text: "a" }] };
  appendToolResultText(result, "footer");
  expect(result.content.length).toBe(2);
  expect(result.content[1]).toEqual({ type: "text", text: "footer" });
});

test("appendToolResultText fills empty content and ignores junk", () => {
  const result: any = { content: "" };
  appendToolResultText(result, "only");
  expect(result.content).toBe("only");
  expect(() => appendToolResultText(null, "x")).not.toThrow();
  const noContent: any = {};
  appendToolResultText(noContent, "text");
  expect(noContent.content).toBe("text");
});
