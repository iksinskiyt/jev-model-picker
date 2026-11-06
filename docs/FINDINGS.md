# Findings — evidence log

> Append-only. Every claim has a probe/command behind it. Update at every compaction.

## 2026-11-06 — NIM live model health (probed from this host)

Method: `GET https://integrate.api.nvidia.com/v1/models` (auth from `~/.local/share/opencode/auth.json` → provider `nvidia`), then `POST /v1/chat/completions` with `max_tokens: 8` (and 200 for confirmation).
Scripts: `F:\code\opencode\scratch\nim_check.py`, `nim_probe.py`, `nim_control.py`, `nim_sub_probe.py`, `nim_final.py`.

**NIM catalog: 84 models listed.**

| Model (NIM id) | Result | Latency | Note |
|---|---|---|---|
| `z-ai/glm-5.3-flash` | **DOWN** | timeout (3x, 240s) | no response at all |
| `z-ai/glm-5.3` | **EOL** | — | `HTTP 410`: "The model 'z-ai/glm-5.3' has reached its end of life on 2026…" |
| `deepseek-ai/deepseek-v4.1-flash` | **DOWN** | timeout | no response |
| `minimaxai/minimax-m3.1-flash` | serving | ~64–78s | cold-start very slow |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | serving | 1.39s | `finish=stop`, real content |
| `nvidia/nemotron-3.5-super-vl-120b-a12b` | serving | 0.85s | vision (VL) |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | serving | 0.64s | omni (multimodal) |
| `nvidia/nemotron-3-ultra-550b-a55b` | serving | 1.05s | |
| `stepfun-ai/step-5-preview` | serving | 6.81s | |

**Critical control experiment**: `z-ai/glm-5.3` returned a real HTTP 410 from NIM *from this host*, which proves egress to
`integrate.api.nvidia.com` is healthy. Therefore the timeouts on `glm-5.3-flash` and `deepseek-v4.1-flash` are genuine
model-side downtime, **not** a local network problem. This is the difference between "NIM is broken" and "these two
endpoints are broken" — it matters, because it means the rest of NIM is usable.

**Consequence**: the active OMO preset is `"nim"`, and `nvidia/z-ai/glm-5.3-flash` was pinned by **three lanes**
(explorer, librarian, observer). All three were silently dead.

## Substitution applied (`C:\Users\mak0114\.config\opencode\oh-my-opencode-slim.json`)

| Lane | Was | Now | Why that model |
|---|---|---|---|
| explorer | `nvidia/z-ai/glm-5.3-flash` | `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b` | "Lightning" speed tier, 1.39s verified; highest-volume lane needs throughput |
| librarian | `nvidia/z-ai/glm-5.3-flash` | `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 0.64s verified, reasoning-capable, unused elsewhere |
| observer | `nvidia/z-ai/glm-5.3-flash` | `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` | explicitly vision (VL) — observer analyses images/PDFs/diagrams |
| council alpha | `opencode-go/kimi-k3.1-pro` | `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` | was assigned to a plan that isn't active |
| council beta | `opencode-go/deepseek-v4.1-flash` | `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | same |

JSON validated. No `opencode-go` refs remain in the council block. Council agents are **not used** during this session
per the user's instruction.

## OpenCode catalog vs. raw NIM id — ref-shape gotcha

OpenCode's `nvidia` provider lists model ids **with a duplicated org prefix**: `providerID=nvidia`, `id=nvidia/z-ai/glm-5.3-flash`
→ full ref `nvidia/nvidia/z-ai/glm-5.3-flash`. The OMO config previously wrote the *short* form `nvidia/z-ai/glm-5.3-flash`.
Both forms have been observed landing on real child sessions, so the host normalises — but the **double form is the
literal catalog ref** and is the safer one to write. All substitutions above use the double form.

## Budget research table (user's `Documents/opencode go.xlsx`, 39 models)

Has: USD/MTok input, output, cached-read, cached-write; monthly USD allowance per model; and the derived
**"real limit"** = millions of tokens you actually get before the allowance is gone.

Best output headroom per month: Muse Spark 1.3 Contributor (300 MTok out), DeepSeek V4.1 Flash off-peak (166),
MiMo-V2.6-Flash (214 out), GLM-5.3-Flash (120). Worst: Gemini 4 Argon (1.5 MTok out for a $30/mo cap),
Kimi K3 (1.0), Grok 4.7 >200K (1.25).

**Live usage fact**: `opencode-go/gemini-4-argon` showed **$1125.53 used against a $30 monthly cap** → exhausted.
Cost per task is dominated by **cached-read** price, not headline input price (measured from the session DB:
orchestrator lane averaged 123M input / 286M cached per task).

## Routing ground truth (7 days, `session_v2` real cost/token columns)

| Agent | Sessions | input | cacheRead | output | cost |
|---|---|---|---|---|---|
| fixer | 7 | 1,480,113 | **47,805,360** | 151,204 | $0.00 |
| designer | 10 | 16,710,939 | 29,857,152 | 315,975 | $0.00 |
| explorer | 4 | 363,149 | 5,849,824 | 28,506 | $0.00 |
| librarian | 2 | 175,878 | 1,714,496 | 1,984 | $0.00 |
| observer | 2 | 24,115 | 16,320 | 1,404 | $0.00 |
| oracle | 2 | 0 | 0 | 0 | — |

**Consequences for the optimiser:**
1. **Cost is $0 everywhere.** All actual work ran on *free* tiers (`opencode/*-free`, `nvidia/*`). The Go plan —
   the thing the budget layer currently optimises for — is **not where the work is happening**. Jev's own recent
   picks (`opencode-go/deepseek-v4.1-flash`, `opencode-go/mimo-v2.6-flash`) aim at a **dead plan**.
   → The scarce resource is **free-tier quota / rate limits**, not Go dollars.
2. **cache-read dominates overwhelmingly**: fixer 47.8M cacheRead vs 1.5M input = **32×**. designer 1.8×.
   Per-task cost is a cache-read prediction problem, not an input-price problem. (Confirms the earlier finding.)
3. **One model carries a lane**: fixer's 47.8M cacheRead is 46.8M on `nvidia/nemotron-3.5-lightning-30b-a3b`
   across 3 sessions. Concentration is a single point of failure — exactly what took out GLM-5.3-Flash.
4. **Ref-shape confirmed in the DB too**: child session rows store
   `{"providerID":"nvidia","id":"nvidia/nemotron-3.5-lightning-30b-a3b"}` — the **doubled** org prefix is what
   actually persists. Our config substitutions use that form.
5. Daily burn peaked Nov 3 (43.5M cacheRead) and is down to 3.9M on Nov 6.

## session-layer interception — live proof it fires

The bridge state file (`~/.config/opencode/jev-model-picker/state.json`) contains four `session-layer` decisions
recorded from **real background subagent dispatches** on Nov 6, each with the correct lane and the lane's pin as
`defaultModel`:

| lane | sessionID | Jev picked | pin it replaced |
|---|---|---|---|
| explorer | `ses_e4f61bb1bffeNrUgu832koELJL` | `opencode-go/deepseek-v4.1-flash` | `nvidia/z-ai/glm-5.3-flash` |
| librarian | `ses_e4f61bb1dffeUA0ppaSw8syv0w` | `opencode-go/mimo-v2.6-flash` | `nvidia/z-ai/glm-5.3-flash` |
| explorer | `ses_e4f88ca63ffevRZfNGe7nzegvs` | `opencode-go/deepseek-v4.1-flash` | `nvidia/z-ai/glm-5.3-flash` |
| librarian | `ses_e4f88ca69ffe5aZ5w5mBK8lv1r` | `opencode-go/mimo-v2.6-flash` | `nvidia/z-ai/glm-5.3-flash` |

Those are `subagent(...)` calls launched **in the background** (no foreground tool call in the transcript).
→ **`session.created` fires for background subagent spawns. Proof by observation, not inference.**

Caveat / open item: all four child sessions were aborted before their first assistant turn (0 messages, 0 parts),
so there is **no billing ground truth yet** proving `switchModel` landed. The `session_v2` row later showed the
*new* config pin, because OMO-Slim re-pushed the preset onto those still-live children (its own `switchModel`
path, `index.js:81931-81934`). Billing proof still TODO.

## NIM model quality benchmark (the evidence behind the lane allocation)

Method: 3–4 checkable probes per model against `https://integrate.api.nvidia.com/v1/chat/completions`
(`max_tokens: 300, temperature: 0`), scoring exact answers. Scripts:
`scratch/bench.py`, `scratch/bench_current.py`, `scratch/bench2.py`, `scratch/deepseek_probe.py`.

| NIM id | Score | Latency | Note |
|---|---|---|---|
| `z-ai/glm-5.3-flash` | 0/4 | **timeout @100s and @240s** | still down after 1.5h |
| `deepseek-ai/deepseek-v4.1-flash` | — | **timeout @240s ×2** | listed in `/v1/models` but not responding |
| `z-ai/glm-5.3` | — | HTTP 410 | EOL, "reached its end of life" |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | — | 3.1s | **returns an EMPTY response** — unusable |
| `nvidia/nemotron-3-super-120b-a12b` | — | — | HTTP error (not served to this account) |
| `nvidia/muse-glimmer-30b`, `poolside/laguna-xs-2.1`, `meta/llama-3.1-nemotron-70b-instruct` | — | — | HTTP error (not served) |
| `minimaxai/minimax-m3.1-flash` | **4/4** | ~75s/req | correct but slow (cold start is not the cause: 71–83s every call) |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 3/3 | **0.75s** | fastest correct model |
| `nvidia/nemotron-3.5-super-vl-120b-a12b` | 3/3 | 2.96s | vision (VL) |
| `stepfun-ai/step-5-preview` | 3/3 | 2.67s | |
| `nvidia/nemotron-3-ultra-550b-a55b` | 3/3 | 4.8s | most capable free model |

**Ref-shape gotcha (cost me a benchmark run)**: the raw NIM API needs the *bare* id
(`nvidia/nemotron-3-ultra-550b-a55b`), while OpenCode's catalog and the OMO config write the *doubled*
form (`nvidia/nvidia/nemotron-3-ultra-550b-a55b`). Passing the doubled form to NIM returns HTTP errors that
look exactly like "model not served" — so a benchmark must use the bare id or it wrongly fails 6/6 models.

### Final `nim` preset allocation (all verified)

| Lane | Model | Why |
|---|---|---|
| orchestrator | `stepfun-ai/step-5-preview` | 3/3, 2.7s — unchanged |
| designer | `stepfun-ai/step-5-preview` | 3/3, 2.7s — unchanged |
| oracle | `nvidia/nemotron-3-ultra-550b-a55b` | 3/3, 4.8s, most capable — unchanged |
| **explorer** | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 3/3, **0.75s** — highest-volume lane wants throughput |
| **librarian** | `nvidia/minimaxai/minimax-m3.1-flash` | **4/4** best quality; lowest volume (2 sessions/7d) so 75s is tolerable |
| **fixer** | `nvidia/nemotron-3-ultra-550b-a55b` | 3/3, 4.8s — removed the broken Lightning-30B |
| **observer** | `nvidia/nemotron-3.5-super-vl-120b-a12b` | 3/3, 2.9s, only VL option — needed for image/PDF analysis |

Deliberate spread: no model carries more than two lanes. The previous allocation put the *broken*
`nemotron-3.5-lightning-30b-a3b` on both explorer and fixer, and left librarian/observer on dead GLM refs.

**Note**: the `zen-free` preset's `opencode/glm-5.3-flash-free` is a *different provider* (OpenCode's own
free tier), was working in the DB (7.9M cacheRead on designer), and is unaffected by the NIM outage.

## Defect found: tests pollute the user's live bridge state

`test/sessions.test.ts` triggers `recordDecisionToBridge`, which writes to
`~/.config/opencode/jev-model-picker/state.json`. The user's real state file is full of test fixtures
(`ses_child_variant`, `c5`, `c4`, `child_1`…). Needs an env-gated/`configDir` seam so tests never touch live state.

