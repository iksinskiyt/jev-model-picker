/**
 * Task digests: the only thing sent to the decision model.
 * Keep them useful but sanitized and small.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // key: value / key = value style secrets
  [/((?:api[_ -]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)([^\s'"]{6,})/gi, "$1[redacted]"],
  // bearer tokens
  [/(bearer\s+)[A-Za-z0-9._\-+/=]{10,}/gi, "$1[redacted]"],
  // long opaque blobs (keys, hashes, base64 payloads)
  [/\b[A-Za-z0-9_\-+/=]{48,}\b/g, "[redacted]"],
];

export function digestTask(text: string, maxChars: number): string {
  let s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  const cap = Math.max(80, maxChars);
  if (s.length > cap) s = s.slice(0, cap - 1) + "…";
  return s;
}
