import type { SystemOneBackendConfig } from "./types";

/**
 * Minimal client for the TypeSafe "System One" API shape:
 *   POST {baseURL}/systemone  { model, state, questions } -> { answers, ... }
 *
 * Works keyless against the OpenCode Zen gateway (jev-1.13-free) and with a
 * Bearer key against https://api.typesafe.ai/v1 (paid / jev-latest).
 */

export interface SystemOneAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  noul?: number;
  score?: number;
}

export interface SystemOneResponse {
  model?: string;
  answers?: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function callSystemOne(
  cfg: SystemOneBackendConfig,
  state: string,
  questions: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<SystemOneResponse> {
  const url = `${cfg.baseURL.replace(/\/+$/, "")}/systemone`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), cfg.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`systemone HTTP ${res.status}`);
    const json: any = await res.json();
    if (!json || typeof json !== "object" || !json.answers) throw new Error("systemone: malformed response");
    return json as SystemOneResponse;
  } finally {
    clearTimeout(timer);
  }
}
