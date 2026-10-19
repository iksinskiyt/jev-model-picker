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
  task: string;
  /** picked price / default price (blended USD/MTok). 1 = same price. */
  ratio: number;
  /** Accumulated savings estimate (USD), filled by the TUI. */
  saved?: number;
};

export type BridgeState = {
  enabled: boolean;
  decisions: BridgeDecision[];
  /** Arbitrary settings written by TUI commands (model allow-list, backend). */
  settings: Record<string, unknown>;
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
    };
  } catch {
    return defaultState();
  }
}

export function writeBridge(state: BridgeState): void {
  try {
    const dir = bridgeDirectory();
    mkdirSync(dir, { recursive: true });
    const file = bridgeFile();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
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
