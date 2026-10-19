import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bridgeDirectory,
  bridgeFile,
  counterfactualGain,
  defaultState,
  readBridge,
  recordDecisionToBridge,
  writeBridge,
} from "../src/bridge";
import { listCandidates } from "../src/catalog";
import { resolveConfig } from "../src/config";

const dir = join(tmpdir(), `jev-bridge-test-${process.pid}`);
process.env.JEV_MODEL_PICKER_STATE = dir;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("readBridge defaults when the file is missing", () => {
  expect(readBridge()).toEqual(defaultState());
});

test("round-trips state through the bridge file", () => {
  const state = defaultState();
  state.enabled = false;
  state.settings.allowlist = ["opencode/a"];
  writeBridge(state);
  const read = readBridge();
  expect(read.enabled).toBe(false);
  expect(read.settings.allowlist).toEqual(["opencode/a"]);
  expect(read.decisions).toEqual([]);
});

test("recordDecisionToBridge prepends and survives re-reads", () => {
  recordDecisionToBridge({
    ts: 1,
    sessionID: "ses_a",
    model: "opencode/a",
    probability: 0.8,
    margin: 0.5,
    reason: "fast",
    backend: "systemone",
    lane: "explorer",
    task: "digest",
    pickedPrice: 0,
    defaultPrice: 6,
  });
  recordDecisionToBridge({
    ts: 2,
    sessionID: "ses_b",
    model: "opencode/b",
    probability: 0.6,
    margin: 0.2,
    reason: "cheap",
    backend: "systemone",
    lane: "librarian",
    task: "digest2",
    pickedPrice: 0,
    defaultPrice: 12,
  });
  const read = readBridge();
  expect(read.decisions.length).toBe(2);
  expect(read.decisions[0]!.model).toBe("opencode/b");
  expect(read.decisions[0]!.defaultPrice).toBe(12);
});

test("recordDecisionToBridge keeps enabled/settings written before it", () => {
  const state = defaultState();
  state.enabled = false;
  writeBridge(state);
  recordDecisionToBridge({
    ts: 3,
    sessionID: "ses_c",
    model: "opencode/c",
    probability: 1,
    margin: 1,
    reason: "x",
    backend: "systemone",
    lane: "fixer",
    task: "d",
    pickedPrice: 3,
    defaultPrice: 3,
  });
  const read = readBridge();
  expect(read.enabled).toBe(false);
  expect(read.decisions.length).toBe(1);
});

test("readBridge heals a corrupt file", () => {
  mkdirSync(bridgeDirectory(), { recursive: true });
  writeFileSync(bridgeFile(), "{not json");
  expect(readBridge()).toEqual(defaultState());
});

test("writeBridge bumps the revision counter", () => {
  const first = defaultState();
  writeBridge(first);
  expect(first.rev).toBe(1);
  expect(readBridge().rev).toBe(1);
  const state = readBridge();
  writeBridge(state);
  expect(state.rev).toBe(2);
  expect(readBridge().rev).toBe(2);
});

test("catalog computes blended price per MTok", async () => {
  const ctx = {
    model: {
      list: async () => [
        { providerID: "free", id: "m", capabilities: { tools: true }, cost: [{ input: 0, output: 0 }] },
        { providerID: "paid", id: "m", capabilities: { tools: true }, cost: [{ input: 3, output: 15 }] },
      ],
    },
  };
  const out = await listCandidates(ctx, resolveConfig({}), undefined, undefined);
  expect(out[0]!.pricePerMTok).toBe(0);
  expect(out[1]!.pricePerMTok).toBe(9);
});

test("catalog allowlist restricts candidates", async () => {
  const ctx = {
    model: {
      list: async () => [
        { providerID: "a", id: "1", capabilities: { tools: true } },
        { providerID: "a", id: "2", capabilities: { tools: true } },
        { providerID: "a", id: "3", capabilities: { tools: true } },
      ],
    },
  };
  const out = await listCandidates(ctx, resolveConfig({}), undefined, undefined, ["a/2"]);
  expect(out.length).toBe(1);
  expect(out[0]!.ref).toBe("a/2");
});

test("counterfactualGain prices free picks by avoided default cost", () => {
  // 5k tokens that cost $0 on a free pick; the default costs $12/MTok.
  expect(counterfactualGain(5000, 12, 0)).toBeCloseTo(0.06, 6);
});

test("counterfactualGain nets actual cost on paid picks", () => {
  // Same tokens on a $3/MTok pick cost $0.015; default $15/MTok → saved $0.06.
  expect(counterfactualGain(5000, 15, 0.015)).toBeCloseTo(0.06, 6);
});

test("counterfactualGain ignores idle windows and negative gains", () => {
  expect(counterfactualGain(0, 12, 0)).toBe(0);
  expect(counterfactualGain(0, 12, 0.05)).toBe(-0.05);
  expect(counterfactualGain(100, 0, 0)).toBe(0);
});
