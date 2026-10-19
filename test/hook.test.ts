import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import { detectLane, extractTask, registerDelegationHook, resetPendingPicks } from "../src/hook";
import type { PickerRuntime } from "../src/pick";

function fakeCtx() {
  const handlers: Record<string, any> = {};
  const ctx = {
    tool: {
      hook: async (name: string, fn: any) => {
        handlers[name] = fn;
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, handlers };
}

function runtimeWithPick(pick: any) {
  return {
    cfg: resolveConfig({}),
    pick,
    lanePin: () => undefined,
    priceRatio: async () => 1,
  } as unknown as PickerRuntime;
}

test("injects the picked model into the delegation input", async () => {
  const { ctx, handlers } = fakeCtx();
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => ({
      ref: "nvidia/z-ai/glm-5.3",
      backend: "systemone:jev-1.13-free",
      latencyMs: 5,
    })),
  );

  const event: any = {
    tool: "subagent",
    input: { agent: "explorer", prompt: "find the relevant code" },
  };
  await handlers["execute.before"](event);

  expect(event.input.model).toBe("nvidia/z-ai/glm-5.3");
});

test("appends the probability footer to the completed tool result", async () => {
  resetPendingPicks();
  const { ctx, handlers } = fakeCtx();
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => ({
      ref: "opencode/deepseek-v4.1-flash-free",
      probability: 0.77,
      margin: 0.72,
      reason: "cost effective",
      backend: "systemone:jev-1.13-free",
      latencyMs: 12,
    })),
  );

  const event: any = {
    tool: "subagent",
    id: "call_1",
    sessionID: "ses_1",
    input: { agent: "librarian", prompt: "look up the docs" },
  };
  await handlers["execute.before"](event);

  const after: any = {
    tool: "subagent",
    id: "call_1",
    status: "completed",
    result: { content: "subagent finished" },
  };
  await handlers["execute.after"](after);

  expect(after.result.content).toContain("subagent finished");
  expect(after.result.content).toContain("JEV picked opencode/deepseek-v4.1-flash-free");
  expect(after.result.content).toContain("77.0%");
});

test("appends a text content item when the result content is an array", async () => {
  resetPendingPicks();
  const { ctx, handlers } = fakeCtx();
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => ({ ref: "a/b", backend: "x", probability: 0.5 })),
  );
  await handlers["execute.before"]({
    tool: "subagent",
    id: "call_2",
    input: { prompt: "do the thing" },
  });
  const after: any = {
    tool: "subagent",
    id: "call_2",
    status: "completed",
    result: { content: [{ type: "text", text: "part" }] },
  };
  await handlers["execute.after"](after);
  expect(after.result.content.length).toBe(2);
  expect(after.result.content[1].text).toContain("JEV picked a/b");
});

test("no footer is appended for error results or unknown calls", async () => {
  resetPendingPicks();
  const { ctx, handlers } = fakeCtx();
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => ({ ref: "a/b", backend: "x", probability: 0.5 })),
  );
  await handlers["execute.before"]({
    tool: "subagent",
    id: "call_3",
    input: { prompt: "task" },
  });
  const errored: any = { tool: "subagent", id: "call_3", status: "error", error: {} };
  await handlers["execute.after"](errored);
  expect(errored.result).toBeUndefined();

  const unknown: any = { tool: "subagent", id: "nope", status: "completed", result: { content: "x" } };
  await handlers["execute.after"](unknown);
  expect(unknown.result.content).toBe("x");
});

test("keeps an explicit model untouched and skips picking", async () => {
  const { ctx, handlers } = fakeCtx();
  let called = 0;
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => {
      called++;
      return undefined;
    }),
  );

  const event: any = {
    tool: "subagent",
    input: { prompt: "p", model: "a/b" },
  };
  await handlers["execute.before"](event);

  expect(called).toBe(0);
  expect(event.input.model).toBe("a/b");
});

test("no pick leaves the call untouched", async () => {
  const { ctx, handlers } = fakeCtx();
  await registerDelegationHook(ctx, runtimeWithPick(async () => undefined));

  const event: any = { tool: "subagent", input: { prompt: "p" } };
  await handlers["execute.before"](event);
  expect(event.input.model).toBeUndefined();
});

test("picker errors never break the call", async () => {
  const { ctx, handlers } = fakeCtx();
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => {
      throw new Error("boom");
    }),
  );

  const event: any = { tool: "subagent", input: { prompt: "p" } };
  await handlers["execute.before"](event);
  expect(event.input.model).toBeUndefined();
});

test("non-delegation tools are ignored", async () => {
  const { ctx, handlers } = fakeCtx();
  let called = 0;
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => {
      called++;
      return undefined;
    }),
  );

  await handlers["execute.before"]({ tool: "read", input: { filePath: "x" } });
  expect(called).toBe(0);
});

test("detectLane and extractTask pick the right fields", () => {
  expect(detectLane({ agent: "fixer" }, ["subagent_type", "agent"])).toBe("fixer");
  expect(detectLane({ subagent_type: "oracle" }, ["subagent_type"])).toBe("oracle");
  expect(detectLane({}, ["agent"])).toBeUndefined();
  expect(extractTask({ prompt: " hi " })).toBe(" hi ");
  expect(extractTask({ description: "d" })).toBe("d");
  expect(extractTask({})).toBeUndefined();
});
