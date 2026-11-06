/**
 * Core shared types for jev-model-picker.
 */

import type { ProgrammaticProvider } from "./providers";

export interface SystemOneBackendConfig {
  kind: "systemone";
  /** Base URL ending in /v1, e.g. https://opencode.ai/inference/systemone/v1 */
  baseURL: string;
  /** System One model id, e.g. jev-1.13-free (Zen) or jev-latest (TypeSafe direct). */
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
}

export interface ChatBackendConfig {
  kind: "chat";
  /** OpenAI-compatible base URL (optional when providerID is configured). */
  baseURL?: string;
  /** OpenCode provider id to resolve baseURL/credentials from (e.g. "nvidia"). */
  providerID?: string;
  /** Chat model id, e.g. z-ai/glm-5.3 on NIM, or any Jev-shaped chat model (openJEV, ...). */
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxTokens: number;
  jsonMode: boolean;
}

export type BackendConfig = SystemOneBackendConfig | ChatBackendConfig;

/** OpenCode Go subscription tier the user pays for. */
export type PlanId = "go" | "go-plus" | "go-teams";

/**
 * Plan-aware budgeting policy: with per-model monthly caps, a great model
 * with an empty bucket is worse than a good model with room left.
 */
export interface BudgetPolicy {
  enabled: boolean;
  /** Subscription tier — drives the monthly allowance per model. */
  plan: PlanId;
  /** Treat a model as unavailable when less than this much USD remains. */
  floorUsd: number;
  /** ...or when less than this % of its monthly cap remains. */
  floorPct: number;
  /** Also honour the 5h/weekly caps (20%/50% of the monthly allowance). */
  windowAware: boolean;
  /**
   * Measure remaining room in *tasks* instead of dollars: a model is only
   * offered when its remaining allowance can absorb another task of the
   * lane's observed size. This is what keeps a fast-draining premium model
   * for the work that needs it.
   */
  capacityAware: boolean;
  /** How many more such tasks a model must be able to absorb. */
  minTasks: number;
  /**
   * Which provider to read live budget data from.
   *
   * `"auto"` (default) uses whichever configured provider can actually be read
   * right now. A named provider pins the source, so a user on e.g. OpenRouter
   * forces their OpenRouter quota to be the constraint instead of Go's.
   * Providers with no readable endpoint (Zen, NIM) can never be pinned — they
   * simply impose no constraint.
   */
  provider?: "auto" | ProgrammaticProvider;
  /** Optional explicit API key for OpenRouter (resolved from auth if omitted). */
  openrouterKey?: string;
}

/** Live budget picture for one capped model. */
export interface BudgetInfo {
  ref: string;
  limitUsd: number;
  usedUsd: number;
  used5h: number;
  cap5h: number;
  usedWeek: number;
  capWeek: number;
  remainingUsd: number;
  remainingPct: number;
  exhausted: boolean;
}

export interface BudgetSnapshot {
  asOf: number;
  plan: PlanId;
  byRef: Record<string, BudgetInfo>;
}

export interface PolicyConfig {
  /** Reject a pick whose probability is below this. 0 = accept anything valid. */
  minProbability: number;
  /** Reject a pick whose probability margin over the runner-up is below this. 0 = off. */
  minMargin: number;
  /** Max candidates offered to the picker per pick. */
  maxCandidates: number;
  /** If the delegation call already carries an explicit model, keep it. */
  respectExplicitModel: boolean;
  /** Reuse a pick for identical (lane, digest) within this window. */
  cacheTtlMs: number;
}

/** Budget configuration per-provider (see providers.ts for full definition). */
export type { BudgetConfig } from "./providers";

export interface PickerConfig {
  enabled: boolean;
  backends: BackendConfig[];
  /** Delegation tool names to intercept. */
  tools: string[];
  /** Input fields on the delegation call that identify the target lane/agent. */
  laneFields: string[];
  /** Explicit per-lane candidate refs; overrides auto-discovery for that lane. */
  lanes: Record<string, string[]>;
  /** Optional per-ref description overrides used in picker criteria. */
  descriptions: Record<string, string>;
  policy: PolicyConfig;
  digest: { maxChars: number };
  omoslimPath?: string;
  omoslimPreset?: string;
  logDecisions: boolean;
  /** Prefer models whose plan allowance still has room. */
  budget: BudgetPolicy;
}

export interface LaneInfo {
  model: string;
  variant?: string;
}

export interface Candidate {
  /** providerID/modelID — the value handed back for delegation overrides. */
  ref: string;
  providerID: string;
  id: string;
  name?: string;
  /** Human/LLM readable description used as choice criteria for the picker. */
  description: string;
  /** Blended USD per million tokens ((input+output)/2). 0 for free models. */
  pricePerMTok: number;
  /** Live plan budget picture, when budget awareness is enabled. */
  budget?: BudgetInfo;
}

export interface PickResult {
  ref: string;
  probability?: number;
  margin?: number;
  reason?: string;
  backend: string;
  latencyMs: number;
  costDelta?: number;
}

export interface DecisionLogEntry {
  ts: string;
  lane?: string;
  digest: string;
  candidates: string[];
  pick?: PickResult;
  fallbackModel?: string;
  /** Candidates withheld because their plan budget is nearly exhausted. */
  budgetSkipped?: string[];
  error?: string;
}
