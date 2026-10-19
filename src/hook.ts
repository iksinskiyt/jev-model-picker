import type { PickerRuntime } from "./pick";

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

/**
 * Persist a pick so the TUI (and any later reader) can render probability
 * bars for it. Best-effort: storage failures never break a delegation.
 */
export async function recordDecision(ctx: any, decision: any): Promise<void> {
  try {
    if (!ctx?.storage?.set) return;
    await ctx.storage.set(
      `jev-decisions/${decision.sessionID}/${decision.callID}`,
      JSON.stringify(decision),
    );
  } catch {
    // logging is best-effort
  }
}

export async function registerDelegationHook(
  ctx: any,
  runtime: PickerRuntime,
): Promise<unknown> {
  const cfg = runtime.cfg;

  return ctx.tool.hook("execute.before", async (event: any) => {
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

      await recordDecision(ctx, {
        sessionID: event?.sessionID ?? "",
        messageID: event?.messageID ?? "",
        callID: event?.id ?? "",
        ts: Date.now(),
        model: pick.ref,
        probability: pick.probability,
        margin: pick.margin,
        reason: pick.reason,
        backend: pick.backend,
        lane: lane ?? "",
        task,
        costDelta: pick.costDelta ?? 0,
      });
    } catch {
      // never break a delegation
    }
  });
}
