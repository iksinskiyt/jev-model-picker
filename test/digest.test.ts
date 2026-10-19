import { expect, test } from "bun:test";
import { digestTask } from "../src/digest";

test("redacts key:value secrets and bearer tokens", () => {
  const s = digestTask(
    "api_key: super-secret-value-123456 and Bearer abcdefghijklmnopqrstuvwxyz then regular text",
    500,
  );
  expect(s).not.toContain("super-secret-value");
  expect(s).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(s).toContain("[redacted]");
  expect(s).toContain("regular text");
});

test("redacts long opaque blobs", () => {
  const blob = "a".repeat(60);
  const s = digestTask(`here is a blob ${blob} ok`, 500);
  expect(s).not.toContain(blob);
  expect(s).toContain("[redacted]");
});

test("collapses whitespace and caps length", () => {
  const s = digestTask("the quick brown fox jumps over the lazy dog ".repeat(200), 100);
  expect(s.length).toBeLessThanOrEqual(100);
  expect(s.endsWith("…")).toBe(true);

  const multiline = digestTask("line one\n\n\tline   two", 500);
  expect(multiline).toBe("line one line two");
});
