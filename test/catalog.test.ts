import { expect, test } from "bun:test";
import { listCandidates } from "../src/catalog";
import { resolveConfig } from "../src/config";

const ctx = {
  model: {
    list: async () => [
      {
        providerID: "opencode",
        id: "deepseek-v4.1-flash-free",
        name: "DS",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
      },
      {
        providerID: "x",
        id: "embed-3",
        name: "embed",
        capabilities: { tools: true },
      },
      {
        providerID: "x",
        id: "no-tools",
        name: "det",
        capabilities: { tools: false },
      },
      {
        providerID: "nvidia",
        id: "z-ai/glm-5.3",
        name: "GLM",
        cost: [{ input: 3, output: 15 }],
        capabilities: { tools: true },
      },
    ],
  },
};

test("filters non-tool and embedding models, marks cost", async () => {
  const out = await listCandidates(ctx, resolveConfig({}), undefined, undefined);
  expect(out.map((c) => c.ref)).toEqual([
    "opencode/deepseek-v4.1-flash-free",
    "nvidia/z-ai/glm-5.3",
  ]);
  expect(out[0]!.description).toContain("free");
  expect(out[0]!.description).toContain("128K ctx");
  expect(out[1]!.description).toContain("paid");
});

test("lane pin sorts first", async () => {
  const out = await listCandidates(
    ctx,
    resolveConfig({}),
    "explorer",
    "nvidia/z-ai/glm-5.3",
  );
  expect(out[0]!.ref).toBe("nvidia/z-ai/glm-5.3");
});

test("explicit lane refs win over auto-discovery", async () => {
  const cfg = resolveConfig({
    lanes: { explorer: ["nvidia/z-ai/glm-5.3"] },
  });
  const out = await listCandidates(ctx, cfg, "explorer", "opencode/deepseek-v4.1-flash-free");
  expect(out.map((c) => c.ref)).toEqual(["nvidia/z-ai/glm-5.3"]);
});

test("respects maxCandidates", async () => {
  const cfg = resolveConfig({ policy: { maxCandidates: 2 } });
  const out = await listCandidates(ctx, cfg, undefined, undefined);
  expect(out.length).toBe(2);
});

test("description overrides apply", async () => {
  const cfg = resolveConfig({
    descriptions: { "opencode/deepseek-v4.1-flash-free": "my favorite" },
  });
  const out = await listCandidates(ctx, cfg, undefined, undefined);
  expect(out[0]!.description).toBe("my favorite");
});
