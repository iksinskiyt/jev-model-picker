import type { BridgeDecision } from "./bridge";
/**
 * Represents a model substitution event recorded by the Jev model picker.
 * Answers: which model was replaced, which model replaced it, and why.
 *
 * source values:
 *   "tool-hook"  — substitution via the tool execution hook (src/hook.ts)
 *   "session-layer" — substitution recorded through the session layer / bridge
 *   "preset-kept" — no substitution happened; the lane's pinned model was kept
 */
export type Substitution = {
  /** The lane/agent where the substitution occurred */
  lane: string;
  /** The model that was replaced (lane pin / preset) */
  from: string;
  /** The model Jev chose as replacement */
  to: string;
  /** Why the substitution happened */
  reason: string;
  /** Confidence 0..1 that the picker chose this model */
  probability?: number;
  /** Budget headroom after the pick */
  capacity?: { tasksLeft: number; exhausted: boolean };
  /** Source path of the substitution */
  source: "tool-hook" | "session-layer" | "preset-kept";
  /** OpenCode session identifier */
  sessionID?: string;
  /** Timestamp (ms since epoch) */
  ts?: number;
};

/**
 * Safely truncate a model reference. Never emits a broken line.
 *
 * The limit is deliberately generous: the whole point of the tell is to name
 * both models, and real refs are long (`opencode-go/deepseek-v4.1-flash` is 32
 * chars, `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` is 45). Only genuinely
 * absurd refs get cut.
 */
const MAX_REF_CHARS = 48;

function truncateRef(ref: string): string {
  if (ref.length <= MAX_REF_CHARS) return ref;
  return ref.substring(0, MAX_REF_CHARS) + "…";
}

/**
 * Human-readable rendering of a substitution as a single explicit line.
 * Designed to be the "tell" — unmissable and answering the three questions
 * at a glance: which model was replaced, which replaced it, and why.
 *
 * Malformed decisions degrade gracefully — never throw.
 */
export function formatSubstitution(s: Substitution): string {
  try {
    const parts: string[] = ["JEV"];

    // Lane — always shown
    parts.push(`· ${s.lane}`);

    // Marker: SUBSTITUTED or PIN KEPT, depending on source
    if (s.source === "preset-kept") {
      parts.push(`· PIN KEPT ${truncateRef(s.to)}`);
    } else {
      parts.push("· SUBSTITUTED");
      parts.push(`${truncateRef(s.from)} → ${truncateRef(s.to)}`);
    }

    // Reason — always present, even if "(none given)"
    parts.push(`· ${s.reason}`);

    // Probability confidence (optional)
    if (s.probability !== undefined) {
      const pct = Math.round(s.probability * 100);
      parts.push(`· ${pct}%`);
    }

    // Capacity / budget headroom (optional)
    if (s.capacity) {
      if (s.capacity.exhausted) {
        parts.push("· plan exhausted");
      } else {
        parts.push(`· ~${s.capacity.tasksLeft} tasks left`);
      }
    }

    return parts.join(" ");
  } catch {
    // Never throw — a malformed decision degrades to a plain line
    return `JEV · ${s.lane} · error rendering substitution`;
  }
}

/**
 * Create a Substitution from a BridgeDecision.
 *
 * If the picked model (`d.model`) differs from the lane's pin
 * (`d.defaultModel`), it is a substitution; `d.backend` decides whether it
 * came through the session layer or the tool hook. If the models match (or no
 * pin is known) the pin was kept → `preset-kept`.
 */
export function substitutionFromDecision(d: BridgeDecision): Substitution {
  // `d.lane` is the lane name; a missing one is a data problem, not a reason to
  // fall back to something that is not a lane.
  const lane = typeof d.lane === "string" ? d.lane : "";
  const from = d.defaultModel || "?";
  const to = d.model;
  const reason = d.reason || "(none given)";

  const hasDefaultModel = !!d.defaultModel;
  const modelDiffers = hasDefaultModel && d.model !== d.defaultModel;

  const source = modelDiffers
    ? d.backend === "session-layer"
      ? "session-layer"
      : "tool-hook"
    : "preset-kept";

  return {
    lane,
    from,
    to,
    reason,
    probability: d.probability,
    source,
    sessionID: d.sessionID,
    ts: d.ts,
    capacity: undefined,
  };
}

/**
 * Sidebar brief: the same substitution, cut to what a ~36 column row can
 * carry — the lane, and the distinguishing part of both model names. The
 * full refs stay in `formatSubstitution()` (panel, transcript, /jev-sub).
 */
const SIDEBAR_WIDTH = 36

/**
 * Ref tokens that are noise at sidebar width: a version (`3`, `3.5`, `v4.1`)
 * or a size (`30b`, `120b`, `a3b`). Family and variant tokens are what tell
 * two candidates apart.
 */
const NOISE_TOKEN = /^(v?\d+(\.\d+)*|\d+(\.\d+)?[bB]?|a\d+(\.\d+)?[bB]?)$/

export type SubstitutionBrief = {
  /** lane row, e.g. `· explorer` */
  laneLine: string
  /** model row, e.g. `  glm-flash → nemotron-nano-omni…` */
  modelLine: string
  /** true when the lane's pin was kept, false when a substitution happened */
  kept: boolean
}

/** Hard cut that always says so: never a silent mid-name chop. */
function clipText(text: string, max: number): string {
  if (max <= 1) return "…"
  if (text.length <= max) return text
  return `${text.substring(0, max - 1)}…`
}

/** `nvidia/z-ai/glm-5.3-flash` → `glm-5.3-flash` — the provider path is noise here. */
function lastSegment(ref: string): string {
  const parts = ref.split("/")
  return parts[parts.length - 1] || ref
}

/** Last segment with version/size tokens dropped, uncapped. */
function cleanRef(ref: string): string {
  const segment = lastSegment(String(ref ?? "").trim())
  if (!segment) return ""
  const tokens = segment.split("-").filter((t) => t && !NOISE_TOKEN.test(t))
  // A ref that is all noise ("30b") still has to render as itself.
  return tokens.length > 0 ? tokens.join("-") : segment
}

/**
 * Shorten a model ref to at most `max` chars. Tokens are dropped from the end
 * until a trailing `…` fits, so the cut is always marked; only a single
 * oversized token is ever cut mid-word.
 */
function shortRef(ref: string, max: number): string {
  const full = cleanRef(ref)
  if (!full) return "?"
  if (max <= 1) return "…"
  if (full.length <= max) return full
  let out = full
  while (out.includes("-") && out.length + 1 > max) {
    out = out.slice(0, out.lastIndexOf("-"))
  }
  return out.length + 1 <= max ? `${out}…` : clipText(out, max)
}

/**
 * Sidebar-sized rendering of a substitution: two rows that name the lane and
 * both models inside `width` columns, with the replacement readable without
 * clicking anything. Malformed input degrades to a plain, short line.
 *
 * A substitution:
 *   · explorer
 *     glm-flash → nemotron-nano-omni…
 */
export function briefSubstitution(s: Substitution, width = SIDEBAR_WIDTH): SubstitutionBrief {
  try {
    const w = Math.max(12, Math.floor(width))
    const lane = clipText(String(s?.lane ?? "").trim(), w - 2) || "jev"
    const kept = s?.source === "preset-kept"
    // Both rows share `width`: row 2 is an indent plus " → " of chrome.
    const budget = Math.max(8, w - 5)
    const half = Math.floor(budget / 2)
    const from = cleanRef(String(s?.from ?? ""))
    const to = cleanRef(String(s?.to ?? ""))
    // The shorter ref lends its slack to the other; `to` keeps at least 4.
    const capFrom = Math.min(from.length, Math.max(half, budget - to.length), budget - 4)
    const capTo = Math.max(4, budget - capFrom)
    // The replacement is the answer, so a short `from` lends it the slack.
    return {
      laneLine: `· ${lane}`,
      modelLine: kept
        ? `  PIN KEPT ${shortRef(String(s?.to ?? ""), capTo)}`
        : `  ${shortRef(String(s?.from ?? ""), capFrom)} → ${shortRef(String(s?.to ?? ""), capTo)}`,
      kept,
    }
  } catch {
    // Never throw — a malformed decision degrades to a plain line
    return { laneLine: "· jev", modelLine: "  substitution", kept: false }
  }
}

/**
 * Aggregate multiple substitutions into a multi-line summary string.
 * Used for display in a panel or sidebar — one line per substitution,
 * ordered most recent first (up to 10).
 */
export function summarizeSubstitutions(list: Substitution[]): string {
  try {
    if (list.length === 0) return "No substitutions recorded.";

    const recent = list.slice(0, 10); // last 10, most recent first already
    const lines: string[] = [];

    for (const s of recent) {
      lines.push(formatSubstitution(s));
    }

    return lines.join("\n");
  } catch {
    return "Error rendering substitution summary.";
  }
}