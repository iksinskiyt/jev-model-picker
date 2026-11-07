import { expect, test } from "bun:test";
import { loadOmoslim, parseOmoslim } from "../src/omoslim";

const SAMPLE = JSON.stringify({
  preset: "nim",
  presets: {
    nim: {
      orchestrator: { model: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
      explorer: {
        model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
        variant: "low",
      },
      fixer: { model: "nvidia/z-ai/glm-5.3" },
    },
    openai: {
      explorer: { model: "openai/gpt-5-mini" },
    },
  },
});

test("parses presets, lanes and variants", () => {
  const parsed = parseOmoslim(SAMPLE);
  expect(parsed?.preset).toBe("nim");
  expect(parsed?.presets.nim?.explorer?.model).toBe(
    "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
  );
  expect(parsed?.presets.nim?.explorer?.variant).toBe("low");
  expect(parsed?.presets.openai?.explorer?.model).toBe("openai/gpt-5-mini");
});

const ARRAY_SAMPLE = JSON.stringify({
  preset: "opencode-go",
  presets: {
    "opencode-go": {
      orchestrator: { model: [{ id: "opencode-go/muse-spark-1.3-contributor", variant: "high" }] },
      fixer: {
        model: [
          { id: "opencode-go/claude-haiku-5-5", variant: "max" },
          { id: "opencode-go/deepseek-v4.1-flash" },
        ],
      },
      observer: { model: [{ id: "opencode-go/mimo-v2.6-pro" }] },
    },
  },
});

test("parses the array model form, taking the FIRST entry as the pin", () => {
  // Regression: the array form made `model` a non-string, so the lane was
  // skipped entirely and every opencode-go lane was invisible to the picker.
  const parsed = parseOmoslim(ARRAY_SAMPLE);
  expect(parsed).toBeDefined();
  const lanes = parsed!.presets["opencode-go"];
  expect(Object.keys(lanes).sort()).toEqual(["fixer", "observer", "orchestrator"]);
  expect(lanes.orchestrator?.model).toBe("opencode-go/muse-spark-1.3-contributor");
  expect(lanes.orchestrator?.variant).toBe("high");
  // The first entry wins, not the last, and its variant comes with it.
  expect(lanes.fixer?.model).toBe("opencode-go/claude-haiku-5-5");
  expect(lanes.fixer?.variant).toBe("max");
  expect(lanes.observer?.variant).toBeUndefined();
});

test("tolerates a BOM and lane entries without model", () => {
  const parsed = parseOmoslim(
    '\uFEFF{"preset":"p","presets":{"p":{"explorer":{"model":"a/b"},"empty":{}}}}',
  );
  expect(parsed?.presets.p?.explorer?.model).toBe("a/b");
  expect(parsed?.presets.p?.empty).toBeUndefined();
});

test("bad json returns undefined", () => {
  expect(parseOmoslim("{oops")).toBeUndefined();
  expect(parseOmoslim("[]")).toBeUndefined();
});

test("loadOmoslim tolerates a missing path", () => {
  const out = loadOmoslim("F:\\definitely\\not\\here.json");
  expect(out === undefined || typeof out === "object").toBe(true);
});
