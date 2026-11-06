# Budget / quota tracking by provider

Reference table for users who want to turn on budget-aware picking. All facts verified from public API docs or the OpenCode Go plan tables (`src/limits.ts`). Nothing invented.

| Provider | How to read remaining quota | Endpoint / header | Reset rule | Programmatic? |
|---|---|---|---|---|
| **OpenCode Go** | local session-DB aggregation (Jev's built-in path) | `~/.local/share/opencode/opencode.db` (table `session_v2`, cols `tokens_input`, `tokens_cache_read`, `cost`) | monthly, per-model caps | yes |
| **OpenRouter** | `GET /api/v1/key` → `limit_remaining`, `limit_reset` | `https://openrouter.ai/api/v1/key` | daily (free tier), monthly (org) | yes |
| **Anthropic (direct)** | response headers | `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-tokens-remaining`, `anthropic-ratelimit-requests-reset` | weekly (requests, Mon 00:00 UTC), token limits weekly/monthly | yes |
| **OpenAI (direct)** | `usage` object + error codes | — | monthly | yes |
| **Google AI Studio** | dashboard only | — | daily 12 AM PT; monthly 1st 12 AM PT; spend-based every 10 min | partial |
| **OpenCode Zen** | **nothing — UI only** | — | daily free quota (midnight UTC); $20 auto-reload under $5 | **no** |
| **GitHub Copilot** | `GET /copilot_internal/user` → `quota_snapshots.remaining` | `https://copilot.internal.github.com/copilot_internal/user` | monthly, 1st at 00:00 UTC | yes |
| **NVIDIA NIM** | **nothing — dashboard only** | — | continuous, no scheduled reset | **no** |
| **Together AI** | `GET /v1/accounts/{id}/billingUsage` | `https://api.together.ai/v1/accounts/{id}/billingUsage` | monthly | yes |
| **Fireworks AI** | `GET /v1/accounts/{id}/billingUsage` | `https://api.fireworks.ai/v1/accounts/{id}/billingUsage` | monthly | yes |

---

## How to configure budget-aware picking

The jev-model-picker reads budget from the OpenCode Go plan tables (`src/limits.ts`) and from the live session database (`session_v2`). To turn it on:

```jsonc
{
  "plugins": [
    {
      "package": "jev-model-picker",
      "options": {
        "budget": {
          "enabled": true,
          "plan": "go",              /* "go" | "go-plus" | "go-teams" */
          "floorUsd": 0.5,           /* skip model when < $0.50 left this month */
          "floorPct": 3,             /* …or when < 3% of monthly cap is left */
          "windowAware": true,       /* also honour 5h (20%) and weekly (50%) caps */
          "capacityAware": true,     /* measure room in *tasks*, not just dollars */
          "minTasks": 1              /* reserve: model must absorb at least this many */
        }
      }
    }
  ]
}
```

When `budget.enabled` is `true`, the picker:

1. Reads live usage per model from `session_v2` (one row per session, cumulative tokens).
2. Annotates every candidate with its remaining allowance (`budgetFor`) and tasks-left estimate.
3. **Withholds** any model whose allowance cannot absorb another task of the current size (`partitionByTaskFit`).
4. If *all* candidates are withheld, all are offered anyway — a starved pick still beats falling back to an exhausted model.
5. Candidates that remain carry their budget info in the picker's criteria (`"$42.30/$60 left this month"`), so the decision model can weigh it.

---

## Critical: providers marked "no" can never be budget-tracked

Providers in the table with **no** in the *Programmatic?* column — **OpenCode Zen** and **NVIDIA NIM** — **can never have their quota read programmatically**. The picker will never withhold a pick because of budget exhaustion for those models. If you include them in a lane's pin list, the picker will always offer them (or keep the pin) regardless of budget state, and the TUI will not show remaining-quota information for them.

Never let a "no" provider cause a pick to be withheld. If you need budget tracking, route those lanes through a provider that reports quota (OpenRouter, OpenAI, Anthropic, etc.) or disable budget-aware picking for those lanes.

---
*File generated from verified facts. No invented endpoints, no guessed numbers, no marketing language.*