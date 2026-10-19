import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import { decideChat, decideSystemOne } from "../src/policy";
import type { Candidate } from "../src/types";

const candidates: Candidate[] = [
  {
    ref: "opencode/deepseek-v4.1-flash-free",
    providerID: "opencode",
    id: "deepseek-v4.1-flash-free",
    description: "free",
  },
  {
    ref: "nvidia/z-ai/glm-5.3",
    providerID: "nvidia",
    id: "z-ai/glm-5.3",
    description: "strong",
  },
];

const cfg = resolveConfig({});

test("picks the valid choice and computes margin", () => {
  const pick = decideSystemOne(
    {
      answers: {
        model: {
          type: "choice",
          choice: "nvidia/z-ai/glm-5.3",
          confidence: 0.8,
          probabilities: {
            "nvidia/z-ai/glm-5.3": 0.8,
            "opencode/deepseek-v4.1-flash-free": 0.2,
          },
        },
      },
    },
    candidates,
    cfg,
  );
  expect(pick?.ref).toBe("nvidia/z-ai/glm-5.3");
  expect(pick?.probability).toBeCloseTo(0.8);
  expect(pick?.margin).toBeCloseTo(0.6);
});

test("matches by model id suffix too", () => {
  const pick = decideSystemOne(
    { answers: { model: { choice: "z-ai/glm-5.3", confidence: 1 } } },
    candidates,
    cfg,
  );
  expect(pick?.ref).toBe("nvidia/z-ai/glm-5.3");
});

test("rejects unknown choices", () => {
  expect(
    decideSystemOne(
      { answers: { model: { choice: "nope/nope", confidence: 1 } } },
      candidates,
      cfg,
    ),
  ).toBeUndefined();
});

test("enforces minProbability", () => {
  const strict = resolveConfig({ policy: { minProbability: 0.9 } });
  expect(
    decideSystemOne(
      { answers: { model: { choice: "nvidia/z-ai/glm-5.3", confidence: 0.5 } } },
      candidates,
      strict,
    ),
  ).toBeUndefined();
});

test("enforces minMargin", () => {
  const strict = resolveConfig({ policy: { minMargin: 0.5 } });
  expect(
    decideSystemOne(
      {
        answers: {
          model: {
            choice: "nvidia/z-ai/glm-5.3",
            probabilities: {
              "nvidia/z-ai/glm-5.3": 0.55,
              "opencode/deepseek-v4.1-flash-free": 0.45,
            },
          },
        },
      },
      candidates,
      strict,
    ),
  ).toBeUndefined();
});

test("chat picks are validated against candidates", () => {
  const ok = decideChat(
    { model: "opencode/deepseek-v4.1-flash-free", confidence: 0.7 },
    candidates,
    cfg,
  );
  expect(ok?.ref).toBe("opencode/deepseek-v4.1-flash-free");
  expect(decideChat({ model: "who/knows" }, candidates, cfg)).toBeUndefined();
});
