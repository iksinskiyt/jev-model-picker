import type { PickerRuntime } from "./pick";
import { recordDecisionToBridge } from "./bridge";
import { appendToolResultText, formatPickFooter } from "./tool";

/**
 * Transparent model injection: intercept delegation tool calls before they
 * execute and rewrite their `model` argument with the picker's choice.
 * Any failure leaves the call completely untouched — never block.
 */

export function detectLane(
  input: any,
  fields: string[],
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function extractTask(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const field of ["prompt", "task", "description", "instructions"]) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function matchesTool(name: string, configured: string[]): boolean {
  const lowered = name.toLowerCase();
  return configured.some((candidate) => {
    const wanted = candidate.toLowerCase();
    return lowered === wanted || lowered.endsWith(`/${wanted}`);
  });
}

const PENDING_TTL_MS = 30 * 60 * 1000;

type PendingPick = { footer: string; ts: number };

/**
 * Picks waiting for their tool call to finish, keyed by tool call id, so the
 * probability bar can be appended to the delegation's own result and appear
 * in the session transcript next to the delegated task.
 */
const pending = new Map<string, PendingPick>();

function prunePending(): void {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (now - entry.ts > PENDING_TTL_MS) pending.delete(id);
  }
}

/** Test seam: forget footnote bookkeeping between runs. */
export function resetPendingPicks(): void {
  pending.clear();
}

export async function registerDelegationHook(
  ctx: any,
  runtime: PickerRuntime,
): Promise<unknown> {
  const cfg = runtime.cfg;
  const registrations: Array<{ dispose: () => Promise<void> }> = [];

  const before = await ctx.tool.hook("execute.before", async (event: any) => {
    try {
      const toolName = String(event?.tool ?? "");
      if (!matchesTool(toolName, cfg.tools)) return;

      const input = event?.input;
      if (!input || typeof input !== "object") return;

      const task = extractTask(input);
      if (!task) return;

      // An explicit model on the call wins (configurable).
      if (
        cfg.policy.respectExplicitModel &&
        typeof input.model === "string" &&
        input.model
      ) {
        return;
      }

      const lane = detectLane(input, cfg.laneFields);
      const pick = await runtime.pick(lane, task);
      if (!pick) return;

      // Mutate in place for hosts that keep the reference…
      input.model = pick.ref;
      // …and replace the input for hosts that swap the object.
      event.input = { ...input, model: pick.ref };

      // Bridge record: probability + price ratio vs the lane's default model.
      const defaultModel = runtime.lanePin(lane) ?? undefined;
      const ratio = await runtime.priceRatio(pick.ref, defaultModel);
      recordDecisionToBridge({
        ts: Date.now(),
        sessionID: String(event?.sessionID ?? ""),
        model: pick.ref,
        defaultModel,
        probability: pick.probability ?? 0,
        margin: pick.margin ?? 0,
        reason: pick.reason ?? "",
        backend: pick.backend ?? "",
        lane: lane ?? "",
        task,
        ratio,
      });

      // Keep the bar for the after-hook so it lands in session history.
      prunePending();
      pending.set(String(event?.id ?? ""), {
        footer: formatPickFooter(pick, {
          lane: lane ?? "",
          defaultModel,
          ratio,
        }),
        ts: Date.now(),
      });
    } catch {
      // never break a delegation
    }
  });
  registrations.push(before);

  const after = await ctx.tool.hook("execute.after", async (event: any) => {
    try {
      if (event?.status !== "completed") return;
      const id = String(event?.id ?? "");
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (event?.result) appendToolResultText(event.result, entry.footer);
    } catch {
      // never break a tool result
    }
  });
  registrations.push(after);

  return async () => {
    for (const registration of registrations.reverse()) {
      try {
        await registration.dispose();
      } catch {
        // ignore
      }
    }
  };
}
