# Session log — 10-hour Jev improvement session

Started 2026-11-06 (user asleep). This file is the compaction checkpoint record.
Update it whenever context is compacted, so nothing measured is lost.

## Status: phase 1 complete and pushed (4 commits)

```
1722674  Improve decision quality of jev-model-picker model picker
6d55964  feat(tell): explicit substitution tell on every path, and multi-provider budget config
ec514b9  docs: NIM quality benchmark and the final lane allocation
645aea2  feat(sessions): session-layer interception with real payload-shape support
```
All pushed to `origin/main`. `bun test` = **156 pass / 0 fail**, `bunx tsc --noEmit` clean.

## Answers to the user's six questions

**1. "Add a tell to see which model was substituted and for what model"** — DONE.
`src/tell.ts` renders one unambiguous line, used identically by the tool-hook footer, the TUI sidebar row,
the `/jev-sub` command, and (new) the session layer:
```
JEV · fixer · SUBSTITUTED opencode-go/claude-haiku-5-5 → opencode-go/deepseek-v4.1-flash
    · deep bucket, cheap per task · 80%
```
A decline renders `PIN KEPT …` so it never reads as a substitution. Truncation raised 30→48 chars because
at 30 the model refs were being cut in half, which defeated the purpose.

**2. "Make sure the substitution works"** — the interception surface is now proven, not assumed:
- `@opencode/protocol/dist/groups/event.d.ts:8959-9069` declares `session.created` with
  `data.{sessionID, parentID, agent, model:{providerID,id,variant}, title}`.
- OMO-Slim's own consumer (`index.js:82962`) does `event.data ?? event.properties ?? event` and reads
  `parentID`/`agent`/`model` with **no foreground/background filter**.
- OMO-Slim's own `switchModel` call sites (`index.js:81931-81934`, `84373-84376`) confirm the exact shape
  `switchModel({ sessionID, model: { providerID, id } })` — which is what `src/sessions.ts` calls.
- **Live proof it fires**: the bridge state contained 4 `session-layer` decisions recorded from *real
  background* `subagent(...)` dispatches, each with the correct lane and the lane's pin as `defaultModel`.
- 11 session-layer tests lock both the V2 (`data.*`) and legacy V1 (`properties.info.*`) payload shapes, so
  a host rename fails a test instead of failing silently.
- **Still open**: billing ground truth. All 4 observed child sessions were aborted before their first
  assistant turn, so no usage row exists yet to confirm which model was charged. TODO for a live run.

**3. "Go tracking optional + more provider options"** — DONE.
`src/providers.ts` registry with fail-soft `readUsage()` adapters: OpenRouter (`GET /api/v1/key` →
`limit_remaining`/`limit_reset`), Anthropic (`anthropic-ratelimit-*` response headers), GitHub Copilot
(`GET /copilot_internal/user` → `quota_snapshots`), OpenCode Go (session DB), plus Together/Fireworks/OpenAI
stubs and **Zen/NIM marked manual** (no endpoint exists → they can never be budget-tracked and must never
withhold a pick). `budget.provider` accepts any programmable id or `auto`; unknown values fall back to
`auto` rather than silently pinning Go.

**4. "Optimize the work given all resources"** — DONE in code, with the key finding being that the
optimisation target was wrong. Measured:
- Every model actually used in the last 7 days is `opencode/*-free` or `nvidia/*`; total cost `$0.00`.
  Jev was picking `opencode-go/*` — a plan whose premium model measured **$1125.53 used vs a $30 cap**.
- cache-read dominates: fixer **47.8M cacheRead vs 1.5M input = 32×**.
- 46.8M of that came from ONE model → single point of failure.
`src/optimize.ts` now ranks by cache-read cost (not input price), excludes known-dark endpoints, penalises
latency for high-volume lanes, reserves premium models for hard tasks, caps any model at 2 lanes, and
understands off-peak pricing. 10 scenario tests assert it does *not* pick the dark/exhausted/expensive option.

**5. Council agents** — they were **my addition**, not a Jev feature, and they were assigned to
`opencode-go/*` while the active preset was `nim`, so they pointed at a dead plan. Re-pointed at verified NIM
models (0 `opencode-go` refs left in the council block). Not used during this session, per your instruction.
The token-harnessing rules are written up in `docs/token-harnessing.md` as a standalone publishable playbook.

**6. Notes in MD + compaction discipline** — `docs/FINDINGS.md` (append-only evidence log), this file,
`docs/budget-providers.md`, `docs/token-harnessing.md`.

## Also fixed (defects found along the way)
- `src/sessions.ts`: `stopped` was declared inside a block whose `return` sat outside it → the disposer
  threw `ReferenceError`. Fixed.
- Objective field was `description`/`label`/`objective`; the real field is **`data.title`**. Fixed, with a
  flattener for both event shapes.
- **Tests were writing into the user's live `~/.config/opencode/jev-model-picker/state.json`.** Tests now
  point `JEV_MODEL_PICKER_STATE` at a throwaway dir; verified the live `rev` no longer moves.
- `tsconfig.json` had `"DOM"` added to `lib` to hide three real type errors in `providers.ts`
  (`{} has no .get()`, wrong Anthropic header names, untyped `resp.json()`). Reverted the hack, fixed the code.
- `tell.ts`'s `substitutionFromDecision` put a *model ref* (`lanePin`) into the *lane* field. Fixed.
- 13 `errors*.txt` + `test-output.txt` + a half-written `src/config.ts.new` left by the subagents — removed.

## Subagent claims that did NOT survive verification (checked, not trusted)
- Lane B reported "1 pre-existing failure in `test/little.test.ts`" — **that file does not exist**. The real
  suite was 102/0.
- Lane A reported "tsc clean" — it was not; 3 errors remained, hidden by the DOM hack.
- Lane A and B reported committing — **neither had committed**; everything was still in the working tree.
- Lane B wrote `src/config.ts.new` because an edit failed mid-write, leaving `config.ts` correct and the
  `.new` file broken debris.
- Lane C touched `src/types.ts` despite being told not to (benign additive type; accepted after review).

## Still TODO
1. **Billing ground truth for the session-layer substitution** — run a real background delegation and read
   `session_v2.model` + `tokens_*` to prove `switchModel` landed.
2. **Enable Jev.** Currently `enabled: false` in the bridge state (last real decision Oct 20). Deliberately
   NOT enabled yet: before the optimisation landed, Jev would have routed to the dead Go plan, which is the
   opposite of the goal. Now that `optimize.ts` excludes it, enabling is the next step.
3. Consider whether `zen-free` preset's `opencode/glm-5.3-flash-free` should be benchmarked too — it is a
   *different* provider from NIM's `z-ai/glm-5.3-flash` and was working in the DB, so it may be a better
   home for those lanes than NIM.
