import type { BackendConfig, ChatBackendConfig, PickerConfig, SystemOneBackendConfig } from "./types";

const DEFAULT_SYSTEMONE_BASE = "https://opencode.ai/inference/systemone/v1";
const DEFAULT_SYSTEMONE_MODEL = "jev-1.13-free";
const DEFAULT_DIGEST_CHARS = 1200;
const DEFAULT_TIMEOUT_MS = 6000;

function asRecord(v: unknown): Record<string, any> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
}

function env(name?: string): string | undefined {
  if (!name) return undefined;
  try {
    return process.env[name] || undefined;
  } catch {
    return undefined;
  }
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v) || v.length === 0) return fallback;
  return v.map(String);
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Merge plugin options (from opencode.jsonc `plugins[].options`) into a
 * fully-defaulted PickerConfig. Never throws — bad input degrades to defaults.
 */
export function resolveConfig(options: unknown): PickerConfig {
  const o = asRecord(options) ?? {};
  const policyO = asRecord(o.policy) ?? {};
  const digestO = asRecord(o.digest) ?? {};
  const sysO = asRecord(o.systemone) ?? {};
  const chatO = asRecord(o.chat) ?? {};
  const backendSel = str(o.backend) ?? "auto";

  const backends: BackendConfig[] = [];

  if (backendSel === "auto" || backendSel === "systemone") {
    const sys: SystemOneBackendConfig = {
      kind: "systemone",
      baseURL: stripSlash(str(sysO.baseURL) ?? DEFAULT_SYSTEMONE_BASE),
      model: str(sysO.model) ?? DEFAULT_SYSTEMONE_MODEL,
      apiKey: str(sysO.apiKey) ?? env(str(sysO.apiKeyEnv)) ?? env("TYPESAFE_API_KEY"),
      apiKeyEnv: str(sysO.apiKeyEnv),
      timeoutMs: num(sysO.timeoutMs, num(policyO.timeoutMs, DEFAULT_TIMEOUT_MS)),
    };
    backends.push(sys);
  }

  const chatConfigured = backendSel === "chat" || (backendSel === "auto" && Object.keys(chatO).length > 0);
  if (chatConfigured) {
    const chat: ChatBackendConfig = {
      kind: "chat",
      baseURL: str(chatO.baseURL) ? stripSlash(String(chatO.baseURL)) : undefined,
      providerID: str(chatO.providerID),
      model: str(chatO.model) ?? "openai/gpt-oss-20b",
      apiKey: str(chatO.apiKey) ?? env(str(chatO.apiKeyEnv)),
      apiKeyEnv: str(chatO.apiKeyEnv),
      timeoutMs: num(chatO.timeoutMs, num(policyO.timeoutMs, DEFAULT_TIMEOUT_MS)),
      maxTokens: num(chatO.maxTokens, 300),
      jsonMode: bool(chatO.jsonMode, false),
    };
    backends.push(chat);
  }

  const lanesO = asRecord(o.lanes) ?? {};
  const lanes: Record<string, string[]> = {};
  for (const [lane, refs] of Object.entries(lanesO)) {
    if (Array.isArray(refs)) lanes[lane] = refs.map(String);
  }

  const descO = asRecord(o.descriptions) ?? {};
  const descriptions: Record<string, string> = {};
  for (const [ref, text] of Object.entries(descO)) {
    if (typeof text === "string" && text) descriptions[ref] = text;
  }

  return {
    enabled: bool(o.enabled, true),
    backends,
    tools: strList(o.tools, ["subagent", "task"]),
    laneFields: strList(o.laneFields, ["subagent_type", "agent", "type"]),
    lanes,
    descriptions,
    policy: {
      minProbability: num(policyO.minProbability, 0),
      minMargin: num(policyO.minMargin, 0),
      maxCandidates: num(policyO.maxCandidates, 12),
      respectExplicitModel: bool(policyO.respectExplicitModel, true),
      cacheTtlMs: num(policyO.cacheTtlMs, 120_000),
    },
    digest: { maxChars: num(digestO.maxChars, DEFAULT_DIGEST_CHARS) },
    omoslimPath: str(o.omoslimPath),
    omoslimPreset: str(o.omoslimPreset),
    logDecisions: bool(o.logDecisions, true),
  };
}
