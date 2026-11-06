import { describe, expect, test } from "bun:test";
import type { PickerRuntime } from "../src/pick";
import type { BridgeDecision } from "../src/bridge";
import { registerSessionInterceptor } from "../src/sessions";
import { resetPendingPicks } from "../src/hook";
import { readBridge } from "../src/bridge";

// Tests must never write to the user's live bridge state. bridgeDirectory()
// honours this env var, so point every test run at a throwaway directory.
process.env.JEV_MODEL_PICKER_STATE = process.env.JEV_TEST_STATE ?? ".jev-test-state";

/** Let the async event drain loop consume every queued event. */
const drain = () => new Promise((r) => setTimeout(r, 20));

type Evt = { type: string; data?: Record<string, unknown> };

function fakeHost(events: Evt[]) {
  const switches: Array<{ sessionID: string; model: { providerID: string; id: string } }> = [];
  const handlers: Record<string, (e: any) => Promise<void>> = {};
  const ctx = {
    event: {
      subscribe: () => {
        let i = 0;
        return {
          next: async () =>
            i < events.length
              ? { value: events[i++], done: false }
              : { value: undefined, done: true },
          return: async () => ({ value: undefined, done: true }),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    },
    session: {
      switchModel: (args: any) => {
        switches.push(args);
        return Promise.resolve({});
      },
      hook: async (name: string, fn: any) => {
        handlers[name] = fn;
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, switches, handlers };
}

function runtimeWith(opts: {
  lanes: string[];
  pins: Record<string, string>;
  pick: (lane: string, task: string) => Promise<any>;
}): PickerRuntime {
  return {
    cfg: {},
    laneNames: () => opts.lanes,
    lanePin: (lane?: string) => (lane ? opts.pins[lane] : undefined),
    pick: opts.pick,
  } as unknown as PickerRuntime;
}

describe("session-layer interception", () => {
  test("applies Jev's pick to a child spawned on the lane pin", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        data: {
          sessionID: "child_1",
          parentID: "root_1",
          agent: "fixer",
          model: { providerID: "opencode-go", id: "claude-haiku-5-5" },
          description: "Polish copy: App + AdminPanel",
        },
      },
    ]);
    const pickCalls: string[] = [];
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["fixer"],
        pins: { fixer: "opencode-go/claude-haiku-5-5" },
        pick: async (lane, task) => {
          pickCalls.push(`${lane}|${task}`);
          return {
            ref: "opencode-go/deepseek-v4.1-flash",
            probability: 0.8,
            margin: 0.4,
            reason: "deep bucket, cheap per task",
            backend: "systemone:jev-1.13-free",
          };
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(pickCalls[0]).toBe("fixer|Polish copy: App + AdminPanel");
    expect(switches).toEqual([
      { sessionID: "child_1", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } },
    ]);
  });

  test("leaves an explicit non-pin model alone but records it", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        data: {
          sessionID: "child_2",
          parentID: "root_1",
          agent: "explorer",
          model: { providerID: "opencode-go", id: "kimi-k3.1-pro" },
          description: "scan the repo for TODO markers",
        },
      },
    ]);
    let picked = 0;
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["explorer"],
        pins: { explorer: "opencode-go/deepseek-v4.1-flash" },
        pick: async () => {
          picked++;
          return { ref: "opencode-go/glm-5.2", backend: "b" };
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(picked).toBe(0); // explicit choice respected
    expect(switches).toEqual([]); // no switchModel
  });

  test("no pick leaves the child on the lane pin", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        data: {
          sessionID: "child_3",
          parentID: "root_1",
          agent: "oracle",
          model: { providerID: "opencode-go", id: "qwen3.8-max" },
          description: "review the auth flow",
        },
      },
    ]);
    let picked = 0;
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["oracle"],
        pins: { oracle: "opencode-go/qwen3.8-max" },
        pick: async () => {
          picked++;
          return undefined;
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(picked).toBe(1);
    expect(switches).toEqual([]);
  });

  test("root sessions and unknown lanes are ignored", async () => {
    const { ctx, switches } = fakeHost([
      { type: "session.created", data: { sessionID: "root_x", agent: "orchestrator" } },
      {
        type: "session.created",
        data: { sessionID: "c", parentID: "root_x", agent: "not-a-lane", model: { providerID: "p", id: "m" } },
      },
    ]);
    let picked = 0;
    await registerSessionInterceptor(
      ctx,
      runtimeWith({ lanes: ["fixer"], pins: {}, pick: async () => { picked++; return { ref: "a/b", backend: "b" }; } }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(picked).toBe(0);
    expect(switches).toEqual([]);
  });

  test("a thin objective falls back to the lane name, not a crash", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        data: { sessionID: "c4", parentID: "r", agent: "designer", model: { providerID: "opencode-go", id: "kimi-k2.7-code" }, description: "polish" },
      },
    ]);
    const seen: string[] = [];
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["designer"],
        pins: { designer: "opencode-go/kimi-k2.7-code" },
        pick: async (_lane, task) => {
          seen.push(task);
          return { ref: "opencode-go/kimi-k3.1-pro", backend: "b", reason: "design rank" };
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(seen[0]).toBe("work in the designer lane");
    expect(switches[0].model.id).toBe("kimi-k3.1-pro");
  });

  test("switchModel failure does not throw", async () => {
    let calls = 0;
    const ctx: any = {
      event: {
        subscribe: () => ({
          next: async () => {
            calls++;
            if (calls > 1) return { value: undefined, done: true };
            return {
              value: {
                type: "session.created",
                data: { sessionID: "c5", parentID: "r", agent: "fixer", model: { providerID: "p", id: "pin" }, description: "a real objective to digest" },
              },
              done: false,
            };
          },
          return: async () => ({ done: true }),
          [Symbol.asyncIterator]() {
            return this;
          },
        }),
      },
      session: {
        switchModel: () => Promise.reject(new Error("host refused")),
      },
    };
    const dispose = await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["fixer"],
        pins: { fixer: "pin" },
        pick: async () => ({ ref: "opencode-go/glm-5.2", backend: "b" }),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    await dispose();
    expect(calls).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // Real payload shapes. These lock the interceptor to what the host actually
  // emits, so a silent rename of `title`/`data`/`properties.info` fails a test
  // rather than failing silently in production.
  //
  // Shape A — V2 / @opencode/protocol `dist/groups/event.d.ts`:
  //   { type: "session.created", data: { sessionID, parentID, agent, model: {providerID,id}, title } }
  // Shape B — legacy V1 emitter (OMO-Slim index.js:82394-82405):
  //   { type: "session.created", properties: { info: { id, parentID, title, agent } } }
  // ---------------------------------------------------------------------

  test("real V2 shape: reads data.title as the objective and switches the model", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        data: {
          sessionID: "ses_child_v2",
          parentID: "ses_root",
          agent: "explorer",
          model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" },
          title: "Grep the monorepo for TODO comments and group them",
          slug: "grep-todos",
        },
      },
    ]);
    const seen: string[] = [];
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["explorer"],
        pins: { explorer: "opencode-go/deepseek-v4.1-flash" },
        pick: async (_lane, task) => {
          seen.push(task);
          return { ref: "opencode-go/mimo-v2.6-flash", backend: "b", reason: "cheaper bucket" };
        },
      }),
    );
    await drain();

    // `title` is the real objective field — without the fix this is undefined.
    expect(seen[0]).toBe("Grep the monorepo for TODO comments and group them");
    expect(switches).toEqual([
      {
        sessionID: "ses_child_v2",
        model: { providerID: "opencode-go", id: "mimo-v2.6-flash" },
      },
    ]);
  });

  test("real legacy V1 shape: properties.info is flattened and used", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        properties: {
          info: {
            id: "ses_child_v1",
            parentID: "ses_root",
            agent: "fixer",
            title: "Polish copy: App + AdminPanel",
          },
        },
      },
    ]);
    const seen: string[] = [];
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["fixer"],
        pins: { fixer: "opencode-go/claude-haiku-5-5" },
        pick: async (_lane, task) => {
          seen.push(task);
          return { ref: "opencode-go/deepseek-v4.1-flash", backend: "b", reason: "cache-friendly" };
        },
      }),
    );
    await drain();

    expect(seen[0]).toBe("Polish copy: App + AdminPanel");
    expect(switches[0].sessionID).toBe("ses_child_v1");
    expect(switches[0].model.id).toBe("deepseek-v4.1-flash");
  });

  test("a child already carrying an explicit non-pin model is left alone", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        data: {
          sessionID: "ses_child_explicit",
          parentID: "ses_root",
          agent: "oracle",
          model: { providerID: "openai", id: "gpt-6-sol" },
          title: "A deliberate user-chosen model for this task",
        },
      },
    ]);
    let picked = 0;
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["oracle"],
        pins: { oracle: "opencode-go/qwen3.8-max" },
        pick: async () => {
          picked++;
          return { ref: "opencode-go/glm-5.3", backend: "b" };
        },
      }),
    );
    await drain();

    expect(picked).toBe(0);
    expect(switches).toEqual([]);
  });

  test("a root session (no parentID) is never touched", async () => {
    const { ctx, switches } = fakeHost([
      {
        type: "session.created",
        data: { sessionID: "ses_root_only", agent: "orchestrator", title: "A root session" },
      },
    ]);
    let picked = 0;
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["fixer"],
        pins: {},
        pick: async () => {
          picked++;
          return { ref: "a/b", backend: "b" };
        },
      }),
    );
    await drain();

    expect(picked).toBe(0);
    expect(switches).toEqual([]);
  });

  test("records a readable substitution tell for the session layer", async () => {
    const { ctx } = fakeHost([
      {
        type: "session.created",
        data: {
          sessionID: "ses_tell_check",
          parentID: "ses_root",
          agent: "fixer",
          model: { providerID: "opencode-go", id: "claude-haiku-5-5" },
          title: "Polish copy in the admin panel components",
        },
      },
    ]);
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["fixer"],
        pins: { fixer: "opencode-go/claude-haiku-5-5" },
        pick: async () => ({
          ref: "opencode-go/deepseek-v4.1-flash",
          probability: 0.8,
          reason: "deep bucket, cheap per task",
          backend: "session-layer",
        }),
      }),
    );
    await drain();

    // The session layer is the one path with no transcript to append a footer
    // to, so its tell must live in the bridge record.
    const decisions = readBridge().decisions;
    const mine = decisions.find((d) => d.sessionID === "ses_tell_check");
    expect(mine).toBeDefined();
    expect(mine!.tell).toContain("SUBSTITUTED");
    expect(mine!.tell).toContain("opencode-go/claude-haiku-5-5");
    expect(mine!.tell).toContain("opencode-go/deepseek-v4.1-flash");
    expect(mine!.tell).toContain("deep bucket, cheap per task");
    // The tell is one line — a broken multi-line tell would wreck the sidebar.
    expect(mine!.tell!.split("\n").length).toBe(1);
  });

  test("records a distinct PIN KEPT tell when Jev declines", async () => {
    const { ctx } = fakeHost([
      {
        type: "session.created",
        data: {
          sessionID: "ses_tell_kept",
          parentID: "ses_root",
          agent: "oracle",
          model: { providerID: "opencode-go", id: "qwen3.8-max" },
          title: "Review the auth flow end to end",
        },
      },
    ]);
    await registerSessionInterceptor(
      ctx,
      runtimeWith({
        lanes: ["oracle"],
        pins: { oracle: "opencode-go/qwen3.8-max" },
        pick: async () => undefined,
      }),
    );
    await drain();

    const decisions = readBridge().decisions;
    const mine = decisions.find((d) => d.sessionID === "ses_tell_kept");
    expect(mine).toBeDefined();
    // A decline must not look like a substitution.
    expect(mine!.tell).toContain("PIN KEPT");
    expect(mine!.tell).not.toContain("SUBSTITUTED");
  });
});
