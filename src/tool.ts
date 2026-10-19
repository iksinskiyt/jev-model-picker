import type { PickerRuntime } from "./pick";

const PICK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "Sanitized digest of the delegated task.",
    },
    lane: {
      type: "string",
      description:
        "Target agent/lane (explorer, fixer, oracle, ...). Optional.",
    },
  },
  required: ["task"],
  additionalProperties: false,
};

const STATUS_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * Unicode probability bar. `█` = filled, `░` = empty. 20 columns ≈ 5% per cell.
 */
export function probabilityBar(fraction: number, width = 20): string {
  const value = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const filled = Math.round(value * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/**
 * Human-readable rendering of a pick, so the answer reads well in the
 * session history: which model won, how confident Jev was, and why.
 */
export function formatPick(pick: {
  ref: string;
  probability: number;
  margin: number;
  reason: string;
  backend: string;
  latencyMs?: number;
}): string {
  const pct = (pick.probability * 100).toFixed(1);
  const lines = [
    `JEV picked ${pick.ref}`,
    `${probabilityBar(pick.probability)} ${pct}%  (margin ${pick.margin.toFixed(2)})`,
    `reason: ${pick.reason}`,
    `backend: ${pick.backend}${pick.latencyMs ? ` · ${pick.latencyMs}ms` : ""}`,
  ];
  return lines.join("\n");
}

export async function registerPickTools(
  ctx: any,
  runtime: PickerRuntime,
): Promise<unknown> {
  return ctx.tool.transform((editor: any) => {
    editor.add({
      name: "jev_pick",
      description:
        "Ask the Jev model picker which model should handle a task. Returns the chosen providerID/modelID plus probability and reason. Returns `model: null` when it cannot pick — keep the lane's pinned model then.",
      input: PICK_INPUT_SCHEMA,
      execute: async (input: any) => {
        const pick = await runtime.pick(
          typeof input?.lane === "string" && input.lane ? input.lane : undefined,
          String(input?.task ?? ""),
        );
        if (!pick) {
          return {
            content: JSON.stringify(
              { model: null, note: "no pick — keep the lane's pinned model" },
              null,
              2,
            ),
          };
        }
        return {
          // Human-readable first so the transcript shows the probability bar,
          // then the machine-readable payload.
          content: [
            formatPick(pick),
            "",
            "```json",
            JSON.stringify(
              {
                model: pick.ref,
                probability: pick.probability,
                margin: pick.margin,
                reason: pick.reason,
                backend: pick.backend,
                latencyMs: pick.latencyMs,
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
        };
      },
    });

    editor.add({
      name: "jev_status",
      description:
        "Show jev-model-picker status: configured backends, OMO-Slim lanes and pins, candidate count, recent decisions.",
      input: STATUS_INPUT_SCHEMA,
      execute: async () => {
        const lanes = runtime.laneNames();
        const pins = lanes.map((l: string) => {
          const pin = runtime.lanePin(l);
          return pin ? `${l}: ${pin.ref}` : `${l}: (none)`;
        });
        return {
          content: [
            "JEV status",
            `Backends: ${runtime.cfg.backends
              .map((b: any) => `${b.kind}:${b.model}`)
              .join(", ")}`,
            `OMO-Slim lanes (${lanes.length}):`,
            ...pins,
            `Candidates: ${runtime.cfg.policy.maxCandidates ?? "default"}`,
            "",
            `Recent picks: ${runtime.cfg.logDecisions ? "logged" : "off"}`,
          ].join("\n"),
        };
      },
    });
  });
}
