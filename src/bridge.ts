import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared bridge state between the server plugin and the TUI plugin.
 *
 * The server records every JEV pick here (with probability, margin, the lane's
 * default model and the price ratio picked/default). The TUI reads it, watches
 * for changes, renders probability bars in the sidebar/session panel, and
 * accumulates a "saved" estimate by attributing family cost deltas.
 *
 * Deliberately not the plugin `storage` domain: the server and TUI hosts are
 * separate processes with separate storage namespaces, but both can read a
 * plain file.
 */

export type BridgeDecision = {
  ts: number;
  sessionID: string;
  model: string;
  /** Lane's default (OMO-Slim pin) model for counterfactual pricing. */
  defaultModel?: string;
  probability: number;
  margin: number;
  reason: string;
  backend: string;
  lane: string;
  /** Full delegated task text (the prompt), shown in the history. */
  task: string;
  /** Blended USD/MTok of the picked model (0 = free). */
  pickedPrice: number;
  /** Blended USD/MTok of the lane's default model (0 = free/unknown). */
  defaultPrice: number;
  /** Accumulated savings estimate (USD), filled by the TUI. */
  saved?: number;
};

export type BridgeState = {
  enabled: boolean;
  decisions: BridgeDecision[];
  /** Arbitrary settings written by TUI commands (model allow-list, backend). */
  settings: Record<string, unknown>;
  /** Monotonic write counter — sidesteps mtime granularity races. */
  rev: number;
};

const MAX_DECISIONS = 200;

export function bridgeDirectory(): string {
  const base =
    process.env.JEV_MODEL_PICKER_STATE?.trim() ||
    process.env.OPENCODE_CONFIG_DIR?.trim() ||
    join(homedir(), ".config", "opencode");
  return join(base, "jev-model-picker");
}

export function bridgeFile(): string {
  return join(bridgeDirectory(), "state.json");
}

export const defaultState = (): BridgeState => ({
  enabled: true,
  decisions: [],
  settings: {},
  rev: 0,
});

export function readBridge(): BridgeState {
  try {
    const file = bridgeFile();
    if (!existsSync(file)) return defaultState();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState();
    return {
      enabled: parsed.enabled !== false,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      settings:
        parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
      rev: typeof parsed.rev === "number" ? parsed.rev : 0,
    };
  } catch {
    return defaultState();
  }
}

/** Atomic write with a bumped revision counter. */
export function writeBridge(state: BridgeState): void {
  try {
    const dir = bridgeDirectory();
    mkdirSync(dir, { recursive: true });
    const file = bridgeFile();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ ...state, rev: Math.max(state.rev ?? 0, 0) + 1 }, null, 2),
    );
    renameSync(tmp, file);
    state.rev = (state.rev ?? 0) + 1;
  } catch {
    // never break a delegation because logging failed
  }
}

export function recordDecisionToBridge(decision: BridgeDecision): void {
  try {
    const state = readBridge();
    state.decisions.unshift(decision);
    if (state.decisions.length > MAX_DECISIONS) {
      state.decisions.length = MAX_DECISIONS;
    }
    writeBridge(state);
  } catch {
    // logging is best-effort
  }
}

/**
 * Savings for one measurement window: what the lane's default model would
 * have cost for the tokens observed, minus what the family actually paid
 * (already on JEV's pick). Works for free picks too, where the observed cost
 * is ~0 but the tokens — and therefore the avoided cost — are real.
 * Returns 0 for windows without new usage or negative gains.
 */
export function counterfactualGain(
  tokenDelta: number,
  defaultPricePerMTok: number,
  costDelta: number,
): number {
  if (tokenDelta <= 0 && costDelta <= 0) return 0;
  const price = Number.isFinite(defaultPricePerMTok) ? Math.max(0, defaultPricePerMTok) : 0;
  const counterfactual = (tokenDelta * price) / 1e6;
  return counterfactual - costDelta;
}
