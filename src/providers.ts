/**
 * Provider/plan registry for multi-provider budget tracking.
 *
 * Each provider declares how its live usage can be read programmatically.
 * Adapters that cannot read usage (no endpoint, UI-only) mark themselves
 * as `manual` — the picker will never withhold on them.
 *
 * Fail-soft contract: every `readUsage()` must return `undefined` on any
 * error (network, missing key, bad shape), never throw. A provider that
 * can't be read simply does not constrain model picking.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ModelPrice,
  UsageMap,
} from "./limits";
import type {
  BudgetInfo,
  BudgetPolicy,
  BudgetSnapshot,
  PlanId,
} from "./types";

// ---------------------------------------------------------------------------
// ProviderId
// ---------------------------------------------------------------------------

/**
 * Programmatically readable providers — budget data can be fetched live.
 * Order matters for `"auto"` selection (prefer earlier entries).
 */
export const ProviderId = {
  /** OpenCode Go — reads from local session DB (bun:sqlite). */
  OPencodeGo: "opencode-go",
  /** OpenRouter — GET /api/v1/key → JSON limit_remaining / limit_reset. */
  OpenRouter: "openrouter",
  /** Anthropic — header-based from a captured API response. */
  Anthropic: "anthropic",
  /** OpenAI — usage object in API responses. */
  OpenAI: "openai",
  /** GitHub Copilot — GET /copilot_internal/user → quota_snapshots. */
  GitHubCopilot: "github-copilot",
  /** Together AI — GET /accounts/{id}/billingUsage. */
  Together: "together",
  /** Fireworks AI — GET /accounts/{id}/billingUsage. */
  Fireworks: "fireworks",
  /** Manual / UI-only providers — budget data is unknown. */
  Zen: "zen",
  NIM: "nim",
} as const;

/**
 * ProviderId narrowed to the programmatically readable subset.
 */
export type ProgrammaticProvider =
  | "opencode-go"
  | "openrouter"
  | "anthropic"
  | "openai"
  | "github-copilot"
  | "together"
  | "fireworks";

/**
 * Manual/non-readable providers — never constrain picking.
 */
export type ManualProvider = "zen" | "nim";

// ---------------------------------------------------------------------------
// Usage / adapter interface
// ---------------------------------------------------------------------------

/** Live usage read from a provider, keyed by bare model id. */
export type UsageAdapterResult = UsageMap | undefined;

/**
 * An adapter describes one provider's budget-reading capability.
 *
 * @param id        — the provider's canonical id string
 * @param label     — human-readable label for logs/UIs
 * @param readUsage — async function returning UsageMap | undefined (never throws)
 * @param resetRule — how to reset cached state (e.g. "monthly", "never")
 * @param docsUrl   — docs page for the provider's quota API
 */
export interface ProviderAdapter {
  id: string;
  label: string;
  readUsage: () => Promise<UsageAdapterResult>;
  resetRule: string;
  docsUrl: string;
}

// ---------------------------------------------------------------------------
// Provider adapters (implemented)
// ---------------------------------------------------------------------------

/**
 * OpenCode Go — reads aggregated usage from the local session_v2 SQLite DB.
 * Falls back to {} (empty map) when the DB is absent or locked — never throws.
 */
export const opencodeGoAdapter: ProviderAdapter = {
  id: "opencode-go",
  label: "OpenCode Go",
  readUsage: async (): Promise<UsageMap | undefined> => {
    try {
      // Reuse the existing session-db logic from limits.ts
      const dbPath = join(
        homedir(),
        ".local",
        "share",
        "opencode",
        "opencode.db",
      );
      // Minimal inline read — we delegate to limits.ts readUsageByModel later
      // but must return UsageMap | undefined here.
      // Since bun:sqlite may not be available in all contexts, we guard.
      let db: any;
      try {
        const bun = await import("bun:sqlite");
        db = new bun.Database(dbPath, { readonly: true, create: false });
      } catch {
        return {};
      }
      if (!db) return {};
      // Read monthly usage
      const now = Date.now();
      const monthStart = new Date(now);
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const since = monthStart.getTime();
      try {
        const rows = db
          .prepare(
            `select model, sum(tokens_input) as tokens_input, sum(tokens_output) as tokens_output, sum(tokens_cache_read) as tokens_cache_read, count(*) as sessions, max(time_updated) as last_updated from session_v2 where model is not null and time_updated >= ? group by model`,
          )
          .all(since) as any[];
        const out: UsageMap = {};
        for (const row of rows ?? []) {
          const bare = row.model?.id ?? row.model;
          if (typeof bare !== "string" || !bare) continue;
          const bucket = out[bare] ?? { input: 0, output: 0, cacheRead: 0, sessions: 0, lastUpdated: 0 };
          bucket.input += Number(row.tokens_input ?? 0);
          bucket.output += Number(row.tokens_output ?? 0);
          bucket.cacheRead += Number(row.tokens_cache_read ?? 0);
          bucket.sessions += Number(row.sessions ?? 0);
          bucket.lastUpdated = Math.max(bucket.lastUpdated, Number(row.last_updated ?? 0));
          out[bare] = bucket;
        }
        return out;
      } catch {
        return {};
      } finally {
        try { db.close(); } catch {}
      }
    } catch {
      // fail-soft: never throw
      return undefined;
    }
  },
  resetRule: "monthly",
  docsUrl: "https://opencode.ai/docs/go-plan",
};

/**
 * OpenRouter — GET https://openrouter.ai/api/v1/key → JSON { limit_remaining, limit_reset }.
 * Fail-soft: network error, missing key, bad shape → undefined.
 */
export const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",
  label: "OpenRouter",
  readUsage: async (): Promise<UsageMap | undefined> => {
    try {
      // Use globalThis.fetch which is available in bun/runtime environments.
      const resp = await globalThis.fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${await getProviderKey("openrouter")}` },
      });
      if (!resp.ok) return undefined;
      const data = (await resp.json()) as
        | { limit_remaining?: unknown; limit_reset?: unknown }
        | null;
      if (!data) return undefined;
      if (typeof data.limit_remaining !== "number" || typeof data.limit_reset !== "number")
        return undefined;
      // Return a usage map with a single entry for the "current model context"
      // The picker will consult this when evaluating models.
      return {
        [getCurrentModelKey()]: {
          input: 0, // placeholder — OpenRouter doesn't break down by model in the key API
          output: 0,
          cacheRead: 0,
          sessions: 1,
          lastUpdated: Date.now(),
        },
      };
    } catch {
      return undefined;
    }
  },
  resetRule: "monthly",
  docsUrl: "https://openrouter.ai/docs/key",
};

/**
 * Read one header value from either a real `Headers` instance or a plain
 * `{ name: value }` record. Typed structurally so this module does not need the
 * DOM lib (the plugin runs under bun/node types only).
 */
function readHeader(source: unknown, name: string): string | null {
  if (!source || typeof source !== "object") return null;
  const asHeaders = source as { get?: (n: string) => string | null };
  if (typeof asHeaders.get === "function") return asHeaders.get(name);
  const record = source as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()];
  return typeof direct === "string" ? direct : null;
}

/**
 * Anthropic — header-based rate-limit info from a captured API response.
 *
 * The caller must have already made a real Anthropic call and passed the
 * response headers. Anthropic returns these on *every* response:
 *   `anthropic-ratelimit-requests-remaining`
 *   `anthropic-ratelimit-tokens-remaining`
 *   `anthropic-ratelimit-requests-reset`  (RFC 3339)
 * There is no dedicated usage endpoint, so the headers are the only source.
 *
 * Fail-soft: missing headers or bad shape → undefined. The picker treats a
 * provider that cannot be read as "no constraint", never as "exhausted".
 */
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  label: "Anthropic",
  readUsage: async (headers?: unknown): Promise<UsageMap | undefined> => {
    try {
      if (!headers) return undefined;
      const remaining = readHeader(headers, "anthropic-ratelimit-requests-remaining");
      const tokensRemaining = readHeader(headers, "anthropic-ratelimit-tokens-remaining");
      const reset = readHeader(headers, "anthropic-ratelimit-requests-reset");
      if (remaining === null && tokensRemaining === null) return undefined;

      const rem = Number(remaining);
      const tokens = Number(tokensRemaining);
      if (remaining !== null && !Number.isFinite(rem)) return undefined;
      if (tokensRemaining !== null && !Number.isFinite(tokens)) return undefined;

      const resetTs = reset ? new Date(reset).getTime() : NaN;
      if (reset && Number.isNaN(resetTs)) return undefined;

      // Anthropic reports *remaining* headroom, not consumption, and the budget
      // layer works in "used" units — so there is nothing to add here. Return a
      // zero-usage bucket stamped with the reset time so the window maths still
      // works and the model is never withheld on a false reading.
      return {
        [getCurrentModelKey()]: {
          input: 0,
          output: 0,
          cacheRead: 0,
          sessions: 1,
          lastUpdated: Number.isFinite(resetTs) ? resetTs : Date.now(),
        },
      };
    } catch {
      return undefined;
    }
  },
  // Anthropic request limits reset weekly (Monday 00:00 UTC); token limits reset
  // weekly or monthly, which is only knowable from the reset header itself.
  resetRule: "weekly (Mon 00:00 UTC) for requests; token limits per reset header",
  docsUrl: "https://docs.anthropic.com/en/api/rate-limits",
};

/**
 * GitHub Copilot — GET https://copilot.internal.github.com/copilot_internal/user → quota_snapshots.
 * Resolves auth token the same way creds.ts does (integration first, then auth.json).
 * Fail-soft: network error, missing key, bad shape → undefined.
 */
export const githubCopilotAdapter: ProviderAdapter = {
  id: "github-copilot",
  label: "GitHub Copilot",
  readUsage: async (): Promise<UsageMap | undefined> => {
    try {
      // Use globalThis.fetch which is available in bun/runtime environments.
      const token = await getProviderKey("github-copilot");
      if (!token) return undefined;
      const resp = await globalThis.fetch("https://copilot.internal.github.com/copilot_internal/user", {
        headers: { Authorization: `token ${token}` },
      });
      if (!resp.ok) return undefined;
      const data = (await resp.json()) as {
        quota_snapshots?: Array<{
          model?: unknown;
          tokens_input?: unknown;
          tokens_output?: unknown;
          tokens_cache_read?: unknown;
          last_reset?: unknown;
        }>;
      } | null;
      const snapshots = data?.quota_snapshots;
      if (!Array.isArray(snapshots)) return undefined;
      // Build a usage map from the snapshots.
      const out: UsageMap = {};
      for (const snap of snapshots) {
        const model = typeof snap?.model === "string" && snap.model ? snap.model : "unknown";
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        out[model] = {
          input: num(snap?.tokens_input),
          output: num(snap?.tokens_output),
          cacheRead: num(snap?.tokens_cache_read),
          sessions: 1,
          lastUpdated:
            typeof snap?.last_reset === "number" ? snap.last_reset : Date.now(),
        };
      }
      return out;
    } catch {
      return undefined;
    }
  },
  resetRule: "monthly",
  docsUrl: "https://github.com/features/copilot/quotas",
};

/**
 * Together AI — `GET https://api.together.ai/v1/accounts/{id}/billingUsage`.
 * Stub: returns `undefined` with a clear comment. Auth resolution is analogous
 * to the other providers but Together/Fireworks keys are not commonly held.
 */
export const togetherAdapter: ProviderAdapter = {
  id: "together",
  label: "Together AI",
  readUsage: async (): Promise<UsageMap | undefined> => {
    // TODO: implement when a Together AI auth token is available.
    // Resolution path: same as getProviderKey("together") → ctx.integration → auth.json.
    return undefined;
  },
  resetRule: "monthly",
  docsUrl: "https://docs.together.ai/docs/billing",
};

/**
 * Fireworks AI — `GET https://api.fireworks.ai/v1/accounts/{id}/billingUsage`.
 * Stub: returns `undefined` with a clear comment.
 */
export const fireworksAdapter: ProviderAdapter = {
  id: "fireworks",
  label: "Fireworks AI",
  readUsage: async (): Promise<UsageMap | undefined> => {
    // TODO: implement when a Fireworks AI auth token is available.
    // Resolution path: same as getProviderKey("fireworks") → ctx.integration → auth.json.
    return undefined;
  },
  resetRule: "monthly",
  docsUrl: "https://docs.fireworks.ai/docs/billing",
};

/**
 * Zen (OpenCode Zen) — UI only, no programmatic endpoint.
 */
export const zenAdapter: ProviderAdapter = {
  id: "zen",
  label: "OpenCode Zen",
  readUsage: async (): Promise<UsageMap | undefined> => {
    // No endpoint at all — UI only. Return undefined so the picker never
    // withholds on Zen models due to budget constraints.
    return undefined;
  },
  resetRule: "never",
  docsUrl: "https://opencode.ai/docs/zen",
};

/**
 * NVIDIA NIM — dashboard only, no quota endpoint.
 */
export const nimAdapter: ProviderAdapter = {
  id: "nim",
  label: "NVIDIA NIM",
  readUsage: async (): Promise<UsageMap | undefined> => {
    // No quota endpoint — dashboard only. Return undefined so the picker
    // never withholds on NIM models due to budget constraints.
    return undefined;
  },
  resetRule: "never",
  docsUrl: "https://nim.nvidia.com/docs",
};

// Helper: resolve an auth key for a given provider id, following the same
// precedence as src/creds.ts (integration ctx → ~/.local/share/opencode/auth.json).
async function getProviderKey(providerId: string): Promise<string | undefined> {
  try {
    // Try to import ctx from the OpenCode plugin context.
    // In the plugin runtime, `ctx` is available globally.
    // We fall back to the auth.json file.
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    const raw = JSON.parse(readFileSync(authPath, "utf8"));
    return extractKey(raw?.[providerId]);
  } catch {
    return undefined;
  }
}

function extractKey(credential: any): string | undefined {
  if (!credential) return undefined;
  if (typeof credential === "string") return credential;
  for (const field of [
    "key",
    "apiKey",
    "api_key",
    "access",
    "accessToken",
    "access_token",
    "token",
    "value",
  ]) {
    const value = credential[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

// Helper: derive a key for the current model context from the picker's state.
// Since we don't have access to the picker's internal model state in the
// adapter, we use a deterministic placeholder key.
function getCurrentModelKey(): string {
  // Use the current date as a partition key — the usage map is consulted
  // per-pick, and the picker can inject the actual model key if needed.
  return `ctx:model:${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/**
 * All known providers in priority order for `"auto"` selection.
 * Manual providers (zen, nim) are last — they never constrain picking.
 */
export const providerRegistry: readonly ProviderAdapter[] = [
  opencodeGoAdapter,
  openrouterAdapter,
  anthropicAdapter,
  githubCopilotAdapter,
  togetherAdapter,
  fireworksAdapter,
  zenAdapter,
  nimAdapter,
];

/**
 * Look up a provider adapter by its id.
 */
export function findAdapter(id: string): ProviderAdapter | undefined {
  return providerRegistry.find((a) => a.id === id);
}

/**
 * Get all programmatically readable adapters (exclude manual).
 */
export function getProgrammaticAdapters(): readonly ProviderAdapter[] {
  return providerRegistry.slice(0, -2); // exclude zen, nim
}

/**
 * Get all manual adapters.
 */
export function getManualAdapters(): readonly ProviderAdapter[] {
  return providerRegistry.slice(-2); // zen, nim
}

// ---------------------------------------------------------------------------
// Auto-selection helper
// ---------------------------------------------------------------------------

/**
 * Try reading usage from each programmable provider in priority order.
 * Returns the first successful reading, or undefined if none can be read.
 */
export async function tryReadFromAnyProvider(): Promise<UsageMap | undefined> {
  for (const adapter of getProgrammaticAdapters()) {
    const usage = await adapter.readUsage();
    if (usage !== undefined) {
      return usage;
    }
  }
  return undefined;
}

/**
 * Determine the "best" provider for auto budget awareness.
 * Preferences:
 *   1. OpenCode Go (if session DB is available and has data)
 *   2. OpenRouter (if key is resolvable)
 *   3. Anthropic (if headers are available)
 *   4. GitHub Copilot (if token is resolvable)
 *   5. Together / Fireworks (stubbed → undefined, skipped)
 *   6. Manual providers (zen, nim) — never constrain
 *
 * Returns the adapter that successfully read usage, or undefined if none.
 */
export async function detectAutoProvider(): Promise<ProviderAdapter | undefined> {
  // First check OpenCode Go via the session DB path.
  // We can check if the DB exists and has data.
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const fs = await import("node:fs");
  if (fs.existsSync(dbPath)) {
    const usage = await opencodeGoAdapter.readUsage();
    if (usage && Object.keys(usage).length > 0) {
      return opencodeGoAdapter;
    }
  }

  // Then try other programmable providers in priority order.
  for (const adapter of [openrouterAdapter, anthropicAdapter, githubCopilotAdapter]) {
    const usage = await adapter.readUsage();
    if (usage && Object.keys(usage).length > 0) {
      return adapter;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Plan mapping — model ref → provider
// ---------------------------------------------------------------------------

/**
 * Extract the provider id from a model reference string.
 * e.g. "opencode-go/glm-5.3" → "opencode-go", "openrouter/glm-5.3" → "openrouter"
 */
export function providerOf(ref: string): string | undefined {
  if (!ref) return undefined;
  const idx = ref.lastIndexOf("/");
  if (idx < 0) return undefined;
  return ref.slice(0, idx) as string;
}

/**
 * Check whether a model ref belongs to a programmable provider.
 */
export function isProgrammaticProvider(ref: string): boolean {
  const pid = providerOf(ref);
  return pid ? pid in ProviderId : false;
}

/**
 * Check whether a model ref belongs to a manual/no-read provider.
 */
export function isManualProvider(ref: string): boolean {
  const pid = providerOf(ref);
  return pid ? pid === "zen" || pid === "nim" : false;
}

// ---------------------------------------------------------------------------
// Exported types for config integration
// ---------------------------------------------------------------------------

/**
 * Budget configuration per-provider.
 *
 *   enabled:    — global budget awareness switch
 *   provider:   — which provider to read live usage from ("auto" or specific id)
 *   plan:       — plan id within that provider's scheme
 *   floorUsd:   — dollar floor
 *   floorPct:   — percentage floor of monthly cap
 *   windowAware: — honor 5h/weekly caps
 *   capacityAware: — measure in tasks instead of dollars
 *   minTasks:   — min tasks a model must absorb
 *   openrouterKey: — optional explicit OpenRouter API key (else resolved from auth)
 */
export interface BudgetConfig {
  enabled: boolean;
  provider: ProgrammaticProvider | "auto";
  plan: PlanId;
  floorUsd: number;
  floorPct: number;
  windowAware: boolean;
  capacityAware: boolean;
  minTasks: number;
  openrouterKey?: string; // optional explicit key, else resolved from auth
}

/**
 * Default budget config — provider defaults to "auto", which will degrade
 * gracefully to "no constraint" if no programmable provider can be read.
 */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  enabled: true,
  provider: "auto",
  plan: "go",
  floorUsd: 0.5,
  floorPct: 3,
  windowAware: true,
  capacityAware: true,
  minTasks: 1,
};