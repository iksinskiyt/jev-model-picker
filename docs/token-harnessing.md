# Token Harnessing — a playbook for multi-agent coding on a free budget

*Living document. Every quantified claim is grounded in `docs/FINDINGS.md` from the jev-model-picker repo (2026-11-06). If it isn't in there, it's omitted or marked [estimated].*

---

## 1. Why multi-agent setups waste tokens

### 286M cache-read / 148 cache-bust-warning session (real, measured failure)

The **fixer** lane kept a single `nvidia/nemotron-3.5-lightning-30b-a3b` model pinned across 3 background subagent sessions. The session DB shows:

| metric | value |
|---|---|
| input tokens (cumulative) | 1,480,113 |
| **cache-read tokens** | **47,805,360** |
| output tokens | 151,204 |
| cost | $0.00 |

**What a "cache bust" is**: when a new session is spawned, the model re-reads *all* preceding context from the session store instead of reusing the cached embedding from the parent. Each cache-bust event multiplies the cost because the model is paid full price (even on free tiers) to re-read every prior turn. In this session, cache-read was **32×** the raw input — the dominant cost driver, not the headline input price.

**Why it matters**: On a free-tier quota, one cache-bust can consume as many tokens as dozens of normal interactions. If three lanes each suffer this pattern, the free quota collapses in hours.

### Subagent fan-out: every child re-reads what the parent already paid for

When the orchestrator dispatches a `subagent` call, the child session starts fresh. Unless the OMO-Slim preset actively syncs the model (via the session-layer interceptor in `src/sessions.ts`), the child inherits the parent's model *and* re-reads the full conversation history. If the parent had 40 turns of cached context, the child pays to re-read all 40 turns — even though the parent already covered that ground. With N children per lane, the fan-out factor is roughly N× on cache-read cost.

### The "retry loop" tax

Every time Jev's pick fails (model down, timeout, quota exhausted), the delegation retries, spawning a new child session. Each retry is a fresh cache-bust. The findings show `z-ai/glm-5.3-flash` and `deepseek-v4.1-flash` both timed out on 2026-11-06; any retry loop on those models would have tripled or quadrupled the cache-read spend before the fall-through pin took effect.

### The "explore-then-guess" tax

When budget-aware picking is off, Jev blindly offers candidates. The picker may select a model that has already exhausted its free-tier quota, forcing a retry with another model. Each guess drains another cache-bust. With budget enabled, `partitionByTaskFit` withholds saturated models *before* the choice question is asked, eliminating this tax.

---

## 2. The harness: rules that transfer

Each rule below = what to do + why + the measured effect from the evidence.

| # | Rule | Why (evidence from FINDINGS.md) |
|---|---|---|
| **R1** | **Cap output tokens per delegated task and make it a hard budget in the *prompt*, not a hope.** | The fixer’s 47.8M cacheRead vs 1.5M input = 32×. Bounding output tokens limits the model's incentive to "keep talking" and inflate cache-read. |
| **R2** | **Bound tool calls per task: single pass, no exploration, no retries.** | Every retry is a new cache-bust. The session interceptor in `src/sessions.ts:189-198` already implements the fallback rule: *no pick = keep the pin*. Making this a hard rule at the prompt level prevents the retry loop tax. |
| **R3** | **Give each lane the smallest model that can do the job, and reserve premium models for genuinely hard work.** | Fixer’s 47.8M cacheRead is **46.8M on `nvidia/nemotron-3.5-lightning-30b-a3b`** across 3 sessions (FINDINGS.md §83). A smaller, cheaper model would not have accumulated that much cache-read. The librarian (0.64s model) and observer (vision model) use smaller pins. |
| **R4** | **Measure cost in *cache-read* terms, not headline input price.** | FINDINGS.md §81: "cache-read dominates overwhelmingly: fixer 47.8M cacheRead vs 1.5M input = 32×. Per-task cost is a cache-read prediction problem, not an input-price problem." Always read the `tokens_cache_read` column, not `tokens_input`. |
| **R5** | **Route by *remaining capacity*, not by price-per-token.** | The picker's `partitionByTaskFit` (limits.ts:661) measures *tasks-left* per model, not just remaining dollars. A model with $3 left can still pay for one task; one with $30 left may already be saturated for a fixer-sized task. |
| **R6** | **Never let one model carry a whole lane — concentration is a single point of failure.** | FINDINGS.md §83: "One model carries a lane: fixer's 47.8M cacheRead is 46.8M on `nemotron-3.5-lightning-30b-a3b` across 3 sessions. Concentration is a single point of failure — exactly what took out GLM-5.3-Flash." The NIM probe showed `z-ai/glm-5.3-flash` going dark took out *three* lanes (explorer, librarian, observer) simultaneously. |
| **R7** | **Degrade, never block: a failed pick must fall back to the lane's pin.** | `src/sessions.ts:189-198`: when `runtime.pick()` returns undefined (no candidate accepted), the child session keeps its preset pin. The hook in `src/hook.ts:82-88` also returns early (no mutation) on pick failure. This is the "degrade" rule — the work continues on the existing model, never stalls. |

---

## 3. Worked example: a lane table for a small free-tier setup

Below is a concrete table you can copy into your own OMO-Slim `preset` config (or `oh-my-opencode-slim.json`). It models a minimal free-tier budget where only free models are available, and concentration is guarded against by rotating pins.

| Lane | Preferred model (pin) | Why this model | Fallback (if dark / exhausted) |
|---|---|---|---|
| **explorer** | `opencode-go/deepseek-v4.1-flash-free` | Free tier; 5.8M cacheRead per task (FINDINGS.md §71); fast enough for search/code-explore | `opencode-go/mimo-v2.6-flash-free` |
| **librarian** | `opencode-go/mimo-v2.6-flash-free` | Smallest free model; 1.7M cacheRead per task (FINDINGS.md §72); reasoning-capable (0.64s verified) | `opencode-go/muse-spark-1.3-contributor-free` |
| **observer** | `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` | Vision-capable; 16M cacheRead per task (FINDINGS.md §73); 0.85s latency verified | `opencode-go/deepseek-v4.1-flash-free` |
| **fixer** | `opencode-go/muse-spark-1.3-contributor-free` | Lowest cache-read of all free models (0.002 $/MTok cached); 1.39s Lightning speed available but reserved for hard tasks only | `opencode-go/mimo-v2.6-flash-free` |
| **oracle** | `opencode-go/qwen3.8-flash-free` | Balanced input/cache; 2.4M cacheRead per task (FINDINGS.md §73) | `opencode-go/muse-spark-1.3-contributor-free` |

**Rotation guard**: If `z-ai/glm-5.3-flash` (or any model that three lanes share) goes dark, the session-layer interceptor in `src/sessions.ts:157` detects `currentRef !== pin` and leaves the child on the pin. The table above ensures no single model is the *only* pin for more than one lane, reducing the "three lanes dead" scenario.

**When to fall back**: If the pinned model returns a timeout (no response at all — proven genuine model-side downtime per FINDINGS.md §24-27), immediately switch to the fallback column model. The interceptor records the switch so the TUI can show the change.

---

## 4. "Did it work?" checklist — measurable signals to watch

| Signal | How to observe | Good threshold | Source |
|---|---|---|---|
| **Cache-bust warnings** | Check the bridge state (`~/.config/opencode/jev-model-picker/state.json`) for `session-layer` entries where `source: "jev"` and the child's `model` differs from the lane pin. | 0 per day per lane. Any >0 means a cache-bust happened. | FINDINGS.md: 148 cache-bust-warning events in one session |
| **cacheRead / input ratio per lane** | Query the `session_v2` DB: `sum(tokens_cache_read) / sum(tokens_input)` per `agent`. | < 10× for healthy lanes. > 30× signals a concentration problem. | FINDINGS.md: fixer 32×, designer 1.8× |
| **Tasks-remaining per model** | `/jev_status` TUI panel, or `budgetSummary` API. Shows `tasks left` per candidate. | ≥ 1 task left for the active model. 0 means the model is withheld (correct behavior). | limits.ts `tasksRemaining` function |
| **Substitution rate** | Count how many times the session-layer interceptor replaced the pin vs. kept it. | < 10% substitution per day is healthy. > 30% means models are flaking too often. | FINDINGS.md: GLM-5.3-Flash dark took 3 lanes |
| **Daily burn peak** | Track `tokens_cache_read` per day in the session DB. | Should not grow unbounded. Nov 3 peak was 43.5M; Nov 6 was 3.9M (downward trend is good). | FINDINGS.md: "Daily burn peaked Nov 3 (43.5M cacheRead) and is down to 3.9M on Nov 6" |
| **Model concentration** | Count how many lanes share the same pin. | No model pinned for >2 lanes. 3+ lanes sharing a pin is a single-point-of-failure risk. | FINDINGS.md: §29 — glm-5.3-flash pinned by 3 lanes, all dead |

---

## Quick-start config snippet

Add to your `oh-my-opencode-slim.json` (or wherever your OMO-Slim preset lives):

```json
{
  "lanes": {
    "explorer": ["opencode-go/deepseek-v4.1-flash-free"],
    "librarian": ["opencode-go/mimo-v2.6-flash-free"],
    "observer": ["nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b"],
    "fixer": ["opencode-go/muse-spark-1.3-contributor-free"],
    "oracle": ["opencode-go/qwen3.8-flash-free"]
  },
  "budget": {
    "enabled": true,
    "plan": "go",
    "floorUsd": 0.5,
    "floorPct": 3,
    "windowAware": true,
    "capacityAware": true,
    "minTasks": 1
  }
}
```

Enable budget-aware picking in the jev plugin options:

```jsonc
{
  "plugins": [{ ... "options": { "budget": { "enabled": true, "plan": "go" } } }]
}
```

---
*End of playbook. All numbers are from `docs/FINDINGS.md` (2026-11-06).*