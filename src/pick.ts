import type {
  BudgetInfo,
  BudgetSnapshot,
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
import {
  budgetFor,
  budgetNote,
  budgetSnapshot,
  DEFAULT_BUDGET_POLICY,
  partitionByBudget,
  resolveBudgetPolicy,
} from "./limits";

export function buildQuestions(
  candidates: Candidate[],
  lane?: string,
  budgetNotes?: Record<string, string | undefined>,
  withheld?: string[],
): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const c of candidates) {
    const note = budgetNotes?.[c.ref];
    criteria[c.ref] = note ? `${c.description} · ${note}` : c.description;
  }

  const hasNotes = budgetNotes
    ? Object.values(budgetNotes).some((n) => !!n)
    : false;

  let budgetGuidance = "";
  if (hasNotes) {
    budgetGuidance +=
      " Each candidate shows its remaining plan budget in parentheses where known — treat a nearly-exhausted model as unavailable unless nothing else fits.";
  }
  if (withheld && withheld.length > 0) {
    budgetGuidance += ` These models were withheld because their plan budget is nearly exhausted: ${withheld.join(", ")}.`;
  }

  return {
    model: {
      type: "choice",
      instructions:
        "Pick the single best model to handle the delegated task described in the state." +
        (lane
          ? ` The task targets the "${lane}" lane; judge requirements as that lane would.`
          : "") +
        " Balance quality first, then speed, then cost. Prefer a free or already-available model unless quality clearly demands more." +
        budgetGuidance,
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
   * Blended USD per MTok for two refs, from the live model catalog.
   * Missing/default-free models resolve to 0 (free).
   */
  async pricesFor(
    pickedRef: string,
    defaultRef?: string,
  ): Promise<{ picked: number; def: number }> {
    try {
      const candidates = await this.candidatesFor();
      const byRef = new Map(candidates.map((c) => [c.ref, c.pricePerMTok]));
      const picked = byRef.get(pickedRef) ?? 0;
      const fallback = defaultRef ? (byRef.get(defaultRef) ?? 0) : 0;
      return {
        picked: Number.isFinite(picked) ? picked : 0,
        def: Number.isFinite(fallback) ? fallback : 0,
      };
    } catch {
      return { picked: 0, def: 0 };
    }
  }

  /** picked price / default price. Kept for the transcript footer summary. */
  async priceRatio(
    pickedRef: string,
    defaultRef?: string,
  ): Promise<number> {
    const { picked, def } = await this.pricesFor(pickedRef, defaultRef);
    if (def <= 0) return 1;
    if (picked <= 0) return 0;
    return picked / def;
  }

  /**
   * Cached plan-budget snapshot, or undefined when budgeting is off or the
   * usage database is unavailable. Never throws.
   */
  async budget(): Promise<BudgetSnapshot | undefined> {
    const policy = resolveBudgetPolicy(
      this.cfg.budget ?? DEFAULT_BUDGET_POLICY,
      readBridge().settings?.budget,
    );
    if (!policy.enabled) return undefined;
    try {
      return await budgetSnapshot({ plan: policy.plan });
    } catch {
      return undefined;
    }
  }

  /** Budget info for one ref (the pick's model, for the footer). */
  async budgetInfo(ref: string): Promise<BudgetInfo | undefined> {
    const snapshot = await this.budget();
    return budgetFor(snapshot, ref);
  }

  /**
   * Human-readable plan usage for `jev_status`: one line per capped model
   * that has been touched this period, cheapest-remaining first.
   */
  async budgetSummary(): Promise<string[]> {
    const snapshot = await this.budget();
    if (!snapshot) return ["budget: disabled"];
    const policy = resolveBudgetPolicy(
      this.cfg.budget ?? DEFAULT_BUDGET_POLICY,
      readBridge().settings?.budget,
    );
    const rows = Object.values(snapshot.byRef)
      .filter((info) => info.usedUsd > 0 || info.exhausted)
      .sort((a, b) => a.remainingPct - b.remainingPct)
      .map((info) => {
        const flags = [info.exhausted ? "exhausted" : undefined].filter(Boolean);
        const pct = (info.remainingPct * 100).toFixed(0);
        return `${info.ref}: $${info.usedUsd.toFixed(2)}/$${info.limitUsd} used (${pct}% left${flags.length ? `, ${flags.join(",")}` : ""})`;
      });
    const head = `budget: plan=${policy.plan} floor=$${policy.floorUsd}/${policy.floorPct}%${
      policy.windowAware ? " window-aware" : ""
    }`;
    return rows.length ? [head, ...rows] : [head, "(no usage this period)"];
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
    const budgetPolicy = resolveBudgetPolicy(
      cfg.budget ?? DEFAULT_BUDGET_POLICY,
      settings.budget,
    );

    const digest = digestTask(taskText, cfg.digest.maxChars);
    if (!digest || digest.length < 16) return undefined;

    const cacheKey = `${lane ?? ""}|${digest}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.t < cfg.policy.cacheTtlMs) return hit.pick;

    let candidates: Candidate[] = [];
    let pick: PickResult | undefined;
    let offered: Candidate[] = [];
    let budgetSkipped: string[] = [];
    const errors: string[] = [];

    try {
      candidates = await this.candidatesFor(
        lane,
        allowlist && allowlist.length ? allowlist : undefined,
      );

      // Live plan budgets: annotate every candidate, then withhold the ones
      // whose allowance cannot absorb another task. When nothing has room we
      // offer everything and let the picker choose (a starved pick still beats
      // falling back to a model that is also exhausted).
      let snapshot: BudgetSnapshot | undefined;
      if (budgetPolicy.enabled) {
        try {
          snapshot = await budgetSnapshot({ plan: budgetPolicy.plan });
        } catch {
          snapshot = undefined;
        }
        for (const c of candidates) c.budget = budgetFor(snapshot, c.ref);
      }

      const { preferred, tight } = partitionByBudget(
        candidates,
        snapshot,
        budgetPolicy,
      );
      if (preferred.length >= 2) {
        offered = preferred;
        budgetSkipped = tight.map((c) => c.ref);
      } else {
        offered = candidates;
      }

      if (offered.length >= 2) {
        const notes: Record<string, string | undefined> = {};
        for (const c of offered) notes[c.ref] = budgetNote(c.budget);
        const questions = buildQuestions(
          offered,
          lane,
          Object.values(notes).some((n) => !!n) ? notes : undefined,
          budgetSkipped.length ? budgetSkipped : undefined,
        );
        const backends = this.backends(linked);
        for (const backend of backends) {
          const startedAt = Date.now();
          try {
            let attempt: PickResult | undefined;
            if (backend.kind === "systemone") {
              const resp = await callSystemOne(backend, digest, questions);
              attempt = decideSystemOne(resp, offered, cfg);
              if (attempt) attempt.backend = `systemone:${backend.model}`;
            } else {
              const resolved = await this.resolveChat(backend);
              const chatPick = await callChat(backend, resolved, digest, offered);
              attempt = decideChat(chatPick, offered, cfg);
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
      candidates: offered.length ? offered.map((c) => c.ref) : candidates.map((c) => c.ref),
      pick,
      fallbackModel: pick ? undefined : this.lanePin(lane),
      budgetSkipped: budgetSkipped.length ? budgetSkipped : undefined,
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
