import type { Candidate, PickerConfig } from "./types";

const EXCLUDE_ID = /(embed|rerank|guard|safety|moderation)/i;

/**
 * Build the candidate list offered to the picker for a given lane.
 *
 * - Auto: every enabled, tool-capable model from ctx.model.list()
 * - Lane pin (from OMO-Slim) is sorted first so criteria skew toward it
 * - Explicit config.lanes[lane] refs win when they resolve; if fewer than 2
 *   resolve (e.g. stale pins) we fall back to auto-discovery
 */
export async function listCandidates(
  ctx: any,
  cfg: PickerConfig,
  lane?: string,
  lanePin?: string,
): Promise<Candidate[]> {
  let models: any[] = [];
  try {
    const raw: any = await ctx?.model?.list?.();
    models = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.models)
        ? raw.models
        : Array.isArray(raw?.data)
          ? raw.data
          : [];
  } catch {
    models = [];
  }

  const seen = new Set<string>();
  const all: Candidate[] = [];

  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const providerID = String(m.providerID ?? m.provider?.id ?? "");
    const id = String(m.id ?? m.modelID ?? "");
    if (!providerID || !id) continue;

    const ref = `${providerID}/${id}`;
    if (seen.has(ref)) continue;

    const caps = m.capabilities ?? {};
    if (caps.tools === false) continue;
    if (EXCLUDE_ID.test(id)) continue;
    if (m.enabled === false) continue;
    if (m.status === "deprecated") continue;

    seen.add(ref);
    const costArr: any[] = Array.isArray(m.cost) ? m.cost : [];
    const paid = costArr.some(
      (c) => Number(c?.input ?? 0) > 0 || Number(c?.output ?? 0) > 0,
    );
    const context = Number(m.limit?.context ?? 0);
    const name = String(m.name ?? id);

    const parts: string[] = [name, `provider ${providerID}`, paid ? "paid" : "free"];
    if (context > 0) parts.push(`${Math.round(context / 1000)}K ctx`);
    const description = cfg.descriptions[ref] ?? parts.join(", ");

    all.push({ ref, providerID, id, name, description });
  }

  const explicit = lane ? cfg.lanes[lane] : undefined;
  let list: Candidate[] = all;

  if (explicit && explicit.length > 0) {
    // explicit config wins; if it resolves to fewer than 2 live refs the
    // picker simply skips and the call keeps its original model
    const byRef = new Map(all.map((c) => [c.ref, c]));
    list = explicit
      .map((r) => byRef.get(r))
      .filter((c): c is Candidate => !!c);
  }

  if (list === all && lanePin) {
    // pinned model first, everything else keeps catalog order
    list = [...all].sort(
      (a, b) => (a.ref === lanePin ? -1 : 0) - (b.ref === lanePin ? -1 : 0),
    );
  }

  const max = Math.max(2, cfg.policy.maxCandidates);
  return list.slice(0, max);
}
