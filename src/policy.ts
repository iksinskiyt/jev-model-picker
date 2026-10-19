import type { Candidate, PickResult, PickerConfig } from "./types";
import type { ChatPick } from "./chat";
import type { SystemOneResponse } from "./systemone";

/**
 * Turn a raw picker response into a validated PickResult — or undefined,
 * in which case the caller keeps the lane's pinned model (never-block policy).
 */

function findCandidate(
  candidates: Candidate[],
  ref?: string,
): Candidate | undefined {
  if (!ref) return undefined;
  return (
    candidates.find((c) => c.ref === ref) ??
    candidates.find((c) => c.id === ref) ??
    candidates.find((c) => c.ref.endsWith(`/${ref}`))
  );
}

function highestOther(
  probs: Record<string, number> | undefined,
  exclude: string[],
): number | undefined {
  if (!probs) return undefined;
  const values = Object.entries(probs)
    .map(([k, v]) => [k, Number(v)] as const)
    .filter(([k, v]) => Number.isFinite(v) && !exclude.includes(k))
    .sort((a, b) => b[1] - a[1]);
  return values[0]?.[1];
}

export function decideSystemOne(
  resp: SystemOneResponse,
  candidates: Candidate[],
  cfg: PickerConfig,
): PickResult | undefined {
  const answer = resp?.answers?.model;
  const choice = typeof answer?.choice === "string" ? answer.choice : undefined;
  const candidate = findCandidate(candidates, choice);
  if (!candidate) return undefined;

  const probs =
    answer?.probabilities && typeof answer.probabilities === "object"
      ? answer.probabilities
      : undefined;

  let probability =
    typeof answer?.confidence === "number" ? answer.confidence : undefined;
  let margin: number | undefined;

  if (probs) {
    const chosenVal =
      probs[candidate.ref] ?? (choice ? probs[choice] : undefined);
    if (probability === undefined && typeof chosenVal === "number") {
      probability = chosenVal;
    }
    const second = highestOther(probs, [
      candidate.ref,
      choice ?? candidate.ref,
    ]);
    if (typeof chosenVal === "number" && typeof second === "number") {
      margin = chosenVal - second;
    }
  }

  if (typeof probability === "number" && probability < cfg.policy.minProbability) {
    return undefined;
  }
  if (typeof margin === "number" && margin < cfg.policy.minMargin) {
    return undefined;
  }

  return {
    ref: candidate.ref,
    probability,
    margin,
    reason:
      choice && choice !== candidate.ref ? `matched "${choice}"` : undefined,
    backend: "systemone",
    latencyMs: 0,
  };
}

export function decideChat(
  pick: ChatPick,
  candidates: Candidate[],
  cfg: PickerConfig,
): PickResult | undefined {
  const candidate = findCandidate(candidates, pick?.model);
  if (!candidate) return undefined;
  if (
    typeof pick.confidence === "number" &&
    pick.confidence < cfg.policy.minProbability
  ) {
    return undefined;
  }
  return {
    ref: candidate.ref,
    probability: pick.confidence,
    reason: pick.reason,
    backend: "chat",
    latencyMs: 0,
  };
}
