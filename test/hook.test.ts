import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import { detectLane, extractTask, registerDelegationHook } from "../src/hook";
import type { PickerRuntime } from "../src/pick";

function fakeCtx() {
  let handler: any;
  const ctx = {
    tool: {
      hook: async (_name: string, fn: any) => {
        handler = fn;
      },
    },
  };
  return { ctx, getHandler: () => handler };
}

function runtimeWithPick(pick: any) {
  return {
    cfg: resolveConfig({}),
    pick,
  } as unknown as PickerRuntime;
}

test("injects the picked model into the delegation input", async () => {
  const { ctx, getHandler } = fakeCtx();
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
  await getHandler()(event);

  expect(event.input.model).toBe("nvidia/z-ai/glm-5.3");
});

test("keeps an explicit model untouched and skips picking", async () => {
  const { ctx, getHandler } = fakeCtx();
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
  await getHandler()(event);

  expect(called).toBe(0);
  expect(event.input.model).toBe("a/b");
});

test("no pick leaves the call untouched", async () => {
  const { ctx, getHandler } = fakeCtx();
  await registerDelegationHook(ctx, runtimeWithPick(async () => undefined));

  const event: any = { tool: "subagent", input: { prompt: "p" } };
  await getHandler()(event);
  expect(event.input.model).toBeUndefined();
});

test("picker errors never break the call", async () => {
  const { ctx, getHandler } = fakeCtx();
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => {
      throw new Error("boom");
    }),
  );

  const event: any = { tool: "subagent", input: { prompt: "p" } };
  await getHandler()(event);
  expect(event.input.model).toBeUndefined();
});

test("non-delegation tools are ignored", async () => {
  const { ctx, getHandler } = fakeCtx();
  let called = 0;
  await registerDelegationHook(
    ctx,
    runtimeWithPick(async () => {
      called++;
      return undefined;
    }),
  );

  await getHandler()({ tool: "read", input: { filePath: "x" } });
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
