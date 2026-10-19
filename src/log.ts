import type { DecisionLogEntry } from "./types";

/** Durable decision log via ctx.storage. Failures are swallowed by design. */
export async function logDecision(
  ctx: any,
  enabled: boolean,
  entry: DecisionLogEntry,
): Promise<void> {
  if (!enabled) return;
  try {
    const key = `decisions/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    await ctx.storage.set(key, entry);
  } catch {
    // logging must never break picking
  }
}
