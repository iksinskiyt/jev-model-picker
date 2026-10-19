import { expect, test } from "bun:test";
import { callSystemOne } from "../src/systemone";
import type { SystemOneBackendConfig } from "../src/types";

const cfg: SystemOneBackendConfig = {
  kind: "systemone",
  baseURL: "https://opencode.ai/inference/systemone/v1/",
  model: "jev-1.13-free",
  timeoutMs: 1000,
};

test("posts the expected shape and parses answers", async () => {
  let seen: any;
  const fakeFetch = (async (url: any, init: any) => {
    seen = { url, body: JSON.parse(init.body), headers: init.headers };
    return new Response(
      JSON.stringify({
        model: "jev-1.13-free",
        answers: { model: { type: "choice", choice: "a/b", confidence: 1 } },
        usage: { input_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const resp = await callSystemOne(cfg, "state text", { model: { type: "choice" } }, fakeFetch);

  expect(seen.url).toBe("https://opencode.ai/inference/systemone/v1/systemone");
  expect(seen.body.model).toBe("jev-1.13-free");
  expect(seen.body.state).toBe("state text");
  expect(seen.headers.Authorization).toBeUndefined();
  expect(resp.answers?.model?.choice).toBe("a/b");
});

test("sends bearer auth when a key is configured", async () => {
  let headers: any;
  const fakeFetch = (async (_url: any, init: any) => {
    headers = init.headers;
    return new Response(JSON.stringify({ answers: {} }), { status: 200 });
  }) as unknown as typeof fetch;

  await callSystemOne({ ...cfg, apiKey: "secret-key" }, "s", {}, fakeFetch);
  expect(headers.Authorization).toBe("Bearer secret-key");
});

test("throws on HTTP errors", async () => {
  const fakeFetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await expect(callSystemOne(cfg, "s", {}, fakeFetch)).rejects.toThrow("500");
});

test("throws on malformed responses", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ model: "x" }), { status: 200 })) as unknown as typeof fetch;
  await expect(callSystemOne(cfg, "s", {}, fakeFetch)).rejects.toThrow("malformed");
});

test("aborts on timeout", async () => {
  const hangingFetch = ((_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  await expect(
    callSystemOne({ ...cfg, timeoutMs: 30 }, "s", {}, hangingFetch),
  ).rejects.toThrow();
});
