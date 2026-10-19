import { expect, test } from "bun:test";
import { appendToolResultText, formatPickFooter, probabilityBar } from "../src/tool";

test("probabilityBar renders filled and empty cells", () => {
  expect(probabilityBar(0, 10)).toBe("░░░░░░░░░░");
  expect(probabilityBar(1, 10)).toBe("██████████");
  expect(probabilityBar(0.5, 10)).toBe("█████░░░░░");
  expect(probabilityBar(-1, 4)).toBe("░░░░");
  expect(probabilityBar(2, 4)).toBe("████");
});

test("formatPickFooter includes bar, percentage, lane and ratio", () => {
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
  expect(footer).toContain("JEV picked opencode/deepseek-v4.1-flash-free");
  expect(footer).toContain("77.0%");
  expect(footer).toContain("margin 0.72");
  expect(footer).toContain("lane librarian");
  expect(footer).toContain("default nvidia/x");
  expect(footer).toContain("25% of default price");
  expect(footer).toContain("264ms");
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
