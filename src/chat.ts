import type { Candidate, ChatBackendConfig } from "./types";

/**
 * OpenAI-compatible chat backend: ask any chat model to pick a candidate.
 * This is how "any model that works the same way" (openJEV, NIM models,
 * local llama.cpp, ...) can act as the decision model.
 */

export interface ChatPick {
  model?: string;
  confidence?: number;
  reason?: string;
}

export function buildChatPrompt(taskDigest: string, candidates: Candidate[]): { system: string; user: string } {
  const list = candidates.map((c) => `- ${c.ref}: ${c.description}`).join("\n");
  return {
    system:
      'You are a model router. Choose exactly one candidate model to handle the user\'s task. ' +
      'Reply with strict JSON only: {"model":"<candidate ref>","confidence":0.0-1.0,"reason":"<short>"}',
    user: `Task:\n${taskDigest}\n\nCandidates:\n${list}\n\nWhich single candidate should handle this task?`,
  };
}

export function parseChatPick(content: string): ChatPick | undefined {
  try {
    const m = String(content ?? "").match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    const j = JSON.parse(m[0]);
    if (!j || typeof j !== "object") return undefined;
    const model = typeof j.model === "string" ? j.model : typeof j.ref === "string" ? j.ref : undefined;
    if (!model) return undefined;
    return {
      model,
      confidence: typeof j.confidence === "number" ? j.confidence : undefined,
      reason: typeof j.reason === "string" ? j.reason : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function callChat(
  cfg: ChatBackendConfig,
  resolved: { baseURL: string; apiKey?: string },
  taskDigest: string,
  candidates: Candidate[],
  fetchImpl: typeof fetch = fetch,
): Promise<ChatPick> {
  const url = `${resolved.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`;

  const { system, user } = buildChatPrompt(taskDigest, candidates);
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: cfg.maxTokens,
  };
  if (cfg.jsonMode) body.response_format = { type: "json_object" };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), cfg.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const json: any = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("chat: malformed response");
    const pick = parseChatPick(content);
    if (!pick) throw new Error("chat: no JSON pick in response");
    return pick;
  } finally {
    clearTimeout(timer);
  }
}
