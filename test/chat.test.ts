import { expect, test } from "bun:test";
import { buildChatPrompt, callChat, parseChatPick } from "../src/chat";
import type { Candidate, ChatBackendConfig } from "../src/types";

const candidates: Candidate[] = [
  { ref: "a/b", providerID: "a", id: "b", description: "fast and cheap" },
  { ref: "c/d", providerID: "c", id: "d", description: "slow but strong" },
];

test("parses a JSON pick, including fenced output", () => {
  expect(parseChatPick('{"model":"a/b","confidence":0.9,"reason":"fast"}')?.model).toBe("a/b");
  expect(
    parseChatPick('```json\n{"model":"c/d","confidence":0.5}\n```')?.model,
  ).toBe("c/d");
  expect(parseChatPick("no json here")).toBeUndefined();
  expect(parseChatPick('{"confidence":1}')).toBeUndefined();
});

test("prompt lists every candidate with its description", () => {
  const { system, user } = buildChatPrompt("do a thing", candidates);
  expect(system).toContain("JSON");
  expect(user).toContain("a/b: fast and cheap");
  expect(user).toContain("c/d: slow but strong");
});

test("callChat posts an OpenAI-compatible body and returns the pick", async () => {
  let seen: any;
  const fakeFetch = (async (url: any, init: any) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"model":"a/b","confidence":0.8,"reason":"cheap"}' } }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const cfg: ChatBackendConfig = {
    kind: "chat",
    model: "router-model",
    timeoutMs: 1000,
    maxTokens: 200,
    jsonMode: true,
  };

  const pick = await callChat(
    cfg,
    { baseURL: "https://example.test/v1/", apiKey: "k" },
    "digest",
    candidates,
    fakeFetch,
  );

  expect(seen.url).toBe("https://example.test/v1/chat/completions");
  expect(seen.body.model).toBe("router-model");
  expect(seen.body.response_format).toEqual({ type: "json_object" });
  expect(pick.model).toBe("a/b");
  expect(pick.confidence).toBe(0.8);
});
