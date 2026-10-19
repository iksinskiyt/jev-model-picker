import type {
  Candidate,
  ChatBackendConfig,
  LaneInfo,
  PickResult,
  PickerConfig,
} from "./types";
import { digestTask } from "./digest";
import { callSystemOne } from "./systemone";
import { callChat } from "./chat";
import { decideChat, decideSystemOne } from "./policy";
import { listCandidates } from "./catalog";
import { loadOmoslim } from "./omoslim";
import { logDecision } from "./log";
import { resolveProviderKey } from "./creds";
import { readBridge } from "./bridge";

export function buildQuestions(
  candidates: Candidate[],
  lane?: string,
): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.ref] = c.description;

  return {
    model: {
      type: "choice",
      instructions:
        "Pick the single best model to handle the delegated task described in the state." +
        (lane
          ? ` The task targets the "${lane}" lane; judge requirements as that lane would.`
          : "") +
        " Balance quality first, then speed, then cost. Prefer a free or already-available model unless quality clearly demands more.",
      criteria,
    },
  };
}

/**
 * The picker runtime: catalog + policy + backends + cache + decision log.
 * `pick()` never throws; undefined means "keep the lane's pinned model".
 */
export class PickerRuntime {
  readonly cfg: PickerConfig;
  private readonly ctx: any;
  private readonly cache = new Map<string, { t: number; pick?: PickResult }>();
  private omoslim?: {
    preset?: string;
    presets: Record<string, Record<string, LaneInfo>>;
  };

  constructor(ctx: any, cfg: PickerConfig) {
    this.ctx = ctx;
    this.cfg = cfg;
  }

  async init(): Promise<void> {
    try {
      this.omoslim = loadOmoslim(this.cfg.omoslimPath);
    } catch {
      this.omoslim = undefined;
    }
  }

  private laneMap(): Record<string, LaneInfo> | undefined {
    const presets = this.omoslim?.presets ?? {};
    const preset = this.cfg.omoslimPreset ?? this.omoslim?.preset;
    if (preset && presets[preset]) return presets[preset];
    return Object.values(presets)[0];
  }

  laneNames(): string[] {
    return Object.keys(this.laneMap() ?? {});
  }

  lanePin(lane?: string): string | undefined {
    if (!lane) return undefined;
    return this.laneMap()?.[lane]?.model;
  }

  async candidatesFor(
    lane?: string,
    allowlist?: string[],
  ): Promise<Candidate[]> {
    return listCandidates(
      this.ctx,
      this.cfg,
      lane,
      this.lanePin(lane),
      allowlist,
    );
  }

  /**
   * picked price / default price (blended USD per MTok). 1 when either side
   * is missing or both are free; >1 when the pick is pricier than default.
   */
  async priceRatio(
    pickedRef: string,
    defaultRef?: string,
  ): Promise<number> {
    try {
      const candidates = await this.candidatesFor();
      const byRef = new Map(candidates.map((c) => [c.ref, c.pricePerMTok]));
      const picked = byRef.get(pickedRef);
      const fallback = defaultRef ? byRef.get(defaultRef) : undefined;
      if (picked === undefined) return 1;
      if (fallback === undefined || fallback <= 0) {
        return fallback === 0 ? 0 : 1;
      }
      return picked / fallback;
    } catch {
      return 1;
    }
  }

  async recentDecisions(limit = 10): Promise<unknown[]> {
    try {
      const page = await this.ctx?.storage?.scan?.({
        prefix: "decisions/",
        limit: Math.max(limit * 2, 20),
      });
      const entries: any[] = page?.entries ?? [];
      return entries
        .sort((a, b) => String(b?.key ?? "").localeCompare(String(a?.key ?? "")))
        .slice(0, limit)
        .map((entry) => ({
          key: entry?.key,
          ...(entry?.value && typeof entry.value === "object"
            ? entry.value
            : {}),
        }));
    } catch {
      return [];
    }
  }

  async pick(
    lane: string | undefined,
    taskText: string,
  ): Promise<PickResult | undefined> {
    const cfg = this.cfg;
    if (!cfg.enabled) return undefined;

    // Bridge state: the TUI can toggle assistance off, restrict candidates,
    // and link a hosted/local decision backend.
    const bridge = readBridge();
    if (!bridge.enabled) return undefined;
    const settings = bridge.settings ?? {};
    const allowlist = Array.isArray(settings.allowlist)
      ? (settings.allowlist as string[]).filter((r) => typeof r === "string")
      : undefined;
    const linked = settings.backend as
      | { baseURL?: string; apiKey?: string; model?: string }
      | undefined;

    const digest = digestTask(taskText, cfg.digest.maxChars);
    if (!digest || digest.length < 16) return undefined;

    const cacheKey = `${lane ?? ""}|${digest}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.t < cfg.policy.cacheTtlMs) return hit.pick;

    let candidates: Candidate[] = [];
    let pick: PickResult | undefined;
    const errors: string[] = [];

    try {
      candidates = await this.candidatesFor(
        lane,
        allowlist && allowlist.length ? allowlist : undefined,
      );
      if (candidates.length >= 2) {
        const questions = buildQuestions(candidates, lane);
        const backends = this.backends(linked);
        for (const backend of backends) {
          const startedAt = Date.now();
          try {
            let attempt: PickResult | undefined;
            if (backend.kind === "systemone") {
              const resp = await callSystemOne(backend, digest, questions);
              attempt = decideSystemOne(resp, candidates, cfg);
              if (attempt) attempt.backend = `systemone:${backend.model}`;
            } else {
              const resolved = await this.resolveChat(backend);
              const chatPick = await callChat(backend, resolved, digest, candidates);
              attempt = decideChat(chatPick, candidates, cfg);
              if (attempt) attempt.backend = `chat:${backend.model}`;
            }
            if (attempt) {
              attempt.latencyMs = Date.now() - startedAt;
              pick = attempt;
              break;
            }
          } catch (e) {
            errors.push(
              `${backend.kind} (${backend.model}): ${
                (e as Error)?.message ?? String(e)
              }`,
            );
          }
        }
      }
    } catch (e) {
      errors.push(`picker: ${(e as Error)?.message ?? String(e)}`);
    }

    this.cache.set(cacheKey, { t: Date.now(), pick });
    await logDecision(this.ctx, cfg.logDecisions, {
      ts: new Date().toISOString(),
      lane,
      digest,
      candidates: candidates.map((c) => c.ref),
      pick,
      fallbackModel: pick ? undefined : this.lanePin(lane),
      error: pick ? undefined : errors.join(" | ") || undefined,
    });
    return pick;
  }

  /**
   * Configured backends, with a TUI-linked backend taking the lead when one
   * is set (hosted URL or a local openJEV endpoint).
   */
  private backends(
    linked?: { baseURL?: string; apiKey?: string; model?: string },
  ): (typeof this.cfg.backends)[number][] {
    const configured = [...this.cfg.backends];
    const baseURL = linked?.baseURL?.trim();
    if (!baseURL) return configured;
    const chatBackend: ChatBackendConfig = {
      kind: "chat",
      baseURL,
      model: linked?.model?.trim() || this.cfg.backends[0]?.model || "jev-1.13-free",
      apiKey: linked?.apiKey?.trim() || undefined,
      timeoutMs: this.cfg.backends[0]?.timeoutMs ?? 6000,
      maxTokens: 2048,
      jsonMode: true,
    };
    return [chatBackend, ...configured];
  }

  private async resolveChat(
    cfg: ChatBackendConfig,
  ): Promise<{ baseURL: string; apiKey?: string }> {
    let baseURL = cfg.baseURL;
    let apiKey = cfg.apiKey;

    if (cfg.providerID) {
      if (!baseURL) {
        try {
          const info = await this.ctx?.provider?.get?.({
            providerID: cfg.providerID,
          });
          baseURL =
            info?.data?.settings?.baseURL ??
            info?.settings?.baseURL ??
            info?.provider?.settings?.baseURL ??
            info?.baseURL ??
            undefined;
        } catch {
          // fall through to the error below
        }
      }
      if (!apiKey) apiKey = await resolveProviderKey(this.ctx, cfg.providerID);
    }

    if (!baseURL) {
      throw new Error(
        "chat backend: no baseURL — set options.chat.baseURL or a resolvable providerID",
      );
    }
    return { baseURL, apiKey };
  }
}
