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

## Repo state

- `src/sessions.ts` session-created interceptor: written, `stopped` scoping bug FIXED (disposer now inside the
  iterator block), test fixture provider mismatch FIXED.
- Full suite: **87 pass / 0 fail**, `bunx tsc --noEmit` clean.
- Uncommitted: `src/index.ts` (registration), `src/sessions.ts`, `test/sessions.test.ts`.
- Jev is currently **disabled** in `~/.config/opencode/jev-model-picker/state.json` (`enabled: false`, last decision Oct 20).
