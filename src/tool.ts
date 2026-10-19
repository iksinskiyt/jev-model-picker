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
        return {
          content: pick
            ? JSON.stringify(
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
              )
            : JSON.stringify(
                { model: null, note: "no pick — keep the lane's pinned model" },
                null,
                2,
              ),
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
        let candidateRefs: string[] = [];
        try {
          candidateRefs = (await runtime.candidatesFor()).map((c) => c.ref);
        } catch {
          candidateRefs = [];
        }

        let availableTools: string[] = [];
        try {
          const list = await ctx?.tool?.list?.();
          availableTools = (list ?? [])
            .map((t: any) => t?.id ?? t?.name)
            .filter((n: any) => typeof n === "string");
        } catch {
          availableTools = [];
        }

        return {
          content: JSON.stringify(
            {
              backends: runtime.cfg.backends.map((b) =>
                b.kind === "systemone"
                  ? {
                      kind: b.kind,
                      model: b.model,
                      baseURL: b.baseURL,
                      keyless: !b.apiKey,
                    }
                  : {
                      kind: b.kind,
                      model: b.model,
                      baseURL: b.baseURL ?? null,
                      providerID: b.providerID ?? null,
                      hasKey: !!b.apiKey,
                    },
              ),
              tools: runtime.cfg.tools,
              availableTools,
              lanes,
              lanePins: Object.fromEntries(
                lanes.map((lane) => [lane, runtime.lanePin(lane) ?? null]),
              ),
              candidates: candidateRefs,
              recentDecisions: await runtime.recentDecisions(5),
            },
            null,
            2,
          ),
        };
      },
    });
  });
}
