/**
 * Zero-dependency probe / smoke test.
 *
 * Run: bun run probe
 *
 * 1. Lists the models exposed by the OpenCode Zen gateway (keyless).
 * 2. Runs one full end-to-end pick through PickerRuntime with a stubbed ctx
 *    (real network call to the keyless systemone endpoint).
 * 3. Prints the OMO-Slim preset/lanes found on this machine, if any.
 */
import { resolveConfig } from "../src/config";
import { PickerRuntime } from "../src/pick";
import { loadOmoslim } from "../src/omoslim";

const GATEWAY_MODELS_URL = "https://opencode.ai/inference/v1/models";

console.log("== 1. OpenCode Zen gateway models (keyless) ==");
try {
  const res = await fetch(GATEWAY_MODELS_URL);
  const json: any = await res.json();
  const items: any[] = json?.data ?? json?.models ?? (Array.isArray(json) ? json : []);
  const ids = items.map((m) => (typeof m === "string" ? m : m?.id ?? m?.modelID)).filter(Boolean);
  console.log(`${res.status} — ${ids.length} models`);
  console.log(ids.join("\n"));
} catch (e) {
  console.log(`gateway list failed: ${(e as Error).message}`);
}

console.log("\n== 2. end-to-end pick through PickerRuntime (stub ctx, real Jev call) ==");
const stubCtx = {
  model: {
    list: async () => [
      {
        providerID: "opencode",
        id: "deepseek-v4.1-flash-free",
        name: "DeepSeek V4.1 Flash Free",
        cost: [{ input: 0, output: 0 }],
        limit: { context: 128_000 },
        capabilities: { tools: true },
      },
      {
        providerID: "nvidia",
        id: "z-ai/glm-5.3",
        name: "GLM 5.3 (NIM)",
        cost: [{ input: 3, output: 15 }],
        limit: { context: 200_000 },
        capabilities: { tools: true },
      },
      {
        providerID: "llama",
        id: "gemma4-26b",
        name: "Gemma 4 26B (local)",
        cost: [],
        limit: { context: 32_000 },
        capabilities: { tools: true },
      },
    ],
  },
  storage: {
    set: async () => {},
    scan: async () => ({ entries: [] }),
  },
};

const runtime = new PickerRuntime(stubCtx, resolveConfig({}));
await runtime.init();

const pick = await runtime.pick(
  "explorer",
  "Grep the whole monorepo for TODO markers, group them by package, and report a concise summary.",
);

console.log(pick ? JSON.stringify(pick, null, 2) : "no pick — would fall back to the lane's pinned model");

console.log("\n== 3. OMO-Slim config ==");
const omo = loadOmoslim();
if (!omo) {
  console.log("oh-my-opencode-slim.json not found");
} else {
  const preset = omo.preset;
  const lanes = preset ? omo.presets[preset] : undefined;
  console.log(`preset: ${preset ?? "(none)"}`);
  for (const [lane, info] of Object.entries(lanes ?? {})) {
    console.log(`  ${lane}: ${info.model}${info.variant ? `#${info.variant}` : ""}`);
  }
}
