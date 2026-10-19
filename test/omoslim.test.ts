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
