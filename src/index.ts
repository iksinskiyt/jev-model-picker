import { Plugin } from "@opencode/plugin";
import { resolveConfig } from "./config";
import { PickerRuntime } from "./pick";
import { registerDelegationHook } from "./hook";
import { registerPickTools } from "./tool";
import { registerSessionInterceptor } from "./sessions";

/**
 * jev-model-picker — OpenCode V2 plugin.
 *
 * A System One decision model (Jev) picks the model for every delegated
 * task, transparently. Falls back to the delegation's original model on any
 * error or ambiguity — never blocks.
 */
export default Plugin.define({
  id: "jev-model-picker",
  async setup(ctx: any) {
    try {
      const cfg = resolveConfig(ctx?.options);

      if (!cfg.enabled) {
        console.log("[jev-model-picker] disabled via options");
        return;
      }

      const runtime = new PickerRuntime(ctx, cfg);
      await runtime.init();
      await registerPickTools(ctx, runtime);
      await registerDelegationHook(ctx, runtime);
      // Session-layer interception: background subagents and OMO-Slim's revived
      // tasks never reach the tool hook, so the same decision is applied to
      // every child session on session.created.
      await registerSessionInterceptor(ctx, runtime);

      const lanes = runtime.laneNames();
      const backends =
        cfg.backends.map((b) => `${b.kind}:${b.model}`).join(", ") || "(none)";
      console.log(
        `[jev-model-picker] ready — backends: ${backends}` +
          (lanes.length ? ` — omo-slim lanes: ${lanes.join(", ")}` : ""),
      );
    } catch (error) {
      // A plugin-side failure must never break host startup.
      console.error("[jev-model-picker] setup failed:", error);
    }
  },
});
