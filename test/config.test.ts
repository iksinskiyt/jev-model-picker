import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import type { SystemOneBackendConfig } from "../src/types";

test("defaults: keyless Jev on the Zen gateway", () => {
  const cfg = resolveConfig(undefined);
  expect(cfg.enabled).toBe(true);
  expect(cfg.backends.length).toBe(1);
  const sys = cfg.backends[0] as SystemOneBackendConfig;
  expect(sys.kind).toBe("systemone");
  expect(sys.model).toBe("jev-1.13-free");
  expect(sys.baseURL).toBe("https://opencode.ai/inference/systemone/v1");
  expect(sys.apiKey).toBeUndefined();
  expect(cfg.tools).toEqual(["subagent", "task"]);
  expect(cfg.laneFields).toEqual(["subagent_type", "agent", "type"]);
});

test("chat backend only activates when configured", () => {
  expect(resolveConfig({}).backends.some((b) => b.kind === "chat")).toBe(false);
  const cfg = resolveConfig({ chat: { providerID: "nvidia", model: "z-ai/glm-5.3" } });
  expect(cfg.backends.map((b) => b.kind)).toEqual(["systemone", "chat"]);
});

test("backend selector narrows the chain", () => {
  expect(resolveConfig({ backend: "systemone" }).backends.map((b) => b.kind)).toEqual([
    "systemone",
  ]);
  expect(
    resolveConfig({ backend: "chat", chat: { providerID: "nvidia", model: "m" } }).backends.map(
      (b) => b.kind,
    ),
  ).toEqual(["chat"]);
});

test("baseURL trailing slashes are stripped", () => {
  const cfg = resolveConfig({
    systemone: { baseURL: "https://api.typesafe.ai/v1///", model: "jev-latest" },
  });
  const sys = cfg.backends[0] as SystemOneBackendConfig;
  expect(sys.baseURL).toBe("https://api.typesafe.ai/v1");
  expect(sys.model).toBe("jev-latest");
});

test("garbage options degrade to defaults", () => {
  const cfg = resolveConfig({ policy: "nope", digest: 42, tools: "x" } as unknown);
  expect(cfg.policy.maxCandidates).toBe(12);
  expect(cfg.tools).toEqual(["subagent", "task"]);
});
