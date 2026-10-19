/**
 * Core shared types for jev-model-picker.
 */

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
  error?: string;
}
