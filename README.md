# jev-model-picker

**Jev picks the model. You keep the flow.**

An [OpenCode V2](https://opencode.ai) plugin that asks a System One decision
model — [Jev](https://typesafe.ai) — which model should handle each delegated
task, then injects the choice transparently into the delegation call.

On any error, timeout, or ambiguity it does *nothing*: the call keeps the model
it already had. It can never block your work.

```
orchestrator ── subagent(agent=explorer, prompt=…) ──►  execute.before hook
                                                              │
                                        sanitized digest (≤1200 chars)
                                                              ▼
                              Jev — typed `choice` question over candidate models
                                                              │
                                    chosen providerID/modelID + probability
                                                              ▼
            subagent(agent=explorer, model=⚡ pick)  ◄── input rewritten
```

- **Works standalone** in any OpenCode V2 setup.
- **First-class [oh-my-opencode-slim](https://www.npmjs.com/package/oh-my-opencode-slim) integration**: reads the active preset's lane pins, biases picks toward each lane's tier, and uses the pin as the fallback.
- **Keyless by default**: Jev via the OpenCode Zen gateway (`jev-1.13-free`) — no API key required.
- **Pluggable decision backend**: any endpoint that speaks the same shapes can pick — TypeSafe's paid API, or any OpenAI-compatible chat model (NVIDIA NIM, local llama.cpp, openJEV, …) via the `chat` backend.

## Install

Add the plugin to your OpenCode V2 config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugins": [
    "oh-my-opencode-slim", // optional
    {
      // Local checkout: point at the directory (absolute path or file:// URL).
      // OpenCode probes <dir>/server, then <dir>/index — this repo ships a root
      // `server.ts` for exactly that. Published: use "jev-model-picker" instead.
      "package": "F:/code/jev-model-picker",
      "options": {
        "systemone": {
          "baseURL": "https://opencode.ai/inference/systemone/v1",
          "model": "jev-1.13-free"
        }
      }
    }
  ]
}
```

That's it — defaults are keyless and safe. See `examples/jev-picker.jsonc` for a
fully annotated example.

## How it works

1. A delegation call (`subagent` / `task`, configurable) passes through the
   plugin's `execute.before` hook.
2. The task prompt is reduced to a **sanitized digest** (secrets redacted,
   capped) and the candidate list is built from `ctx.model.list()` — enabled,
   tool-capable models only.
3. Jev answers a typed `choice` question: one option per candidate, described
   by name, provider, cost tier and context size; the lane's pinned model is
   described first.
4. The chosen `providerID/modelID` is written into the delegation's `model`
   argument — the orchestrator never sees the seam.
5. The decision is logged to plugin storage (`decisions/*`).

If Jev errors, times out, answers off-list, or confidence/margin misses your
policy thresholds, the hook leaves the call untouched.

## Configuration

All options go under the plugin entry's `options`:

| option | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `backend` | `"auto"` | `"auto"` \| `"systemone"` \| `"chat"` |
| `systemone.baseURL` | Zen gateway | System One endpoint (must end in `/v1`) |
| `systemone.model` | `jev-1.13-free` | decision model id |
| `systemone.apiKey` / `apiKeyEnv` | — | bearer key for paid endpoints (`TYPESAFE_API_KEY` env fallback) |
| `chat.providerID` / `model` | off | fallback chat backend (OpenCode provider + model id) |
| `chat.baseURL` / `apiKey` / `apiKeyEnv` | — | for direct OpenAI-compatible endpoints |
| `chat.jsonMode` | `false` | send `response_format: json_object` |
| `tools` | `["subagent","task"]` | tool names to intercept |
| `laneFields` | `["subagent_type","agent","type"]` | input fields naming the target lane |
| `lanes` | `{}` | explicit candidate refs per lane (e.g. `{"explorer": ["nvidia/z-ai/glm-5.3"]}`) |
| `descriptions` | `{}` | per-ref criteria overrides for the picker |
| `policy.minProbability` | `0` | reject picks below this probability |
| `policy.minMargin` | `0` | reject picks with a thinner margin over the runner-up |
| `policy.maxCandidates` | `12` | candidates offered per pick |
| `policy.respectExplicitModel` | `true` | an explicit `model` on the call always wins |
| `policy.timeoutMs` | `6000` | backend timeout |
| `policy.cacheTtlMs` | `120000` | reuse a pick for identical (lane, digest) |
| `digest.maxChars` | `1200` | digest cap |
| `logDecisions` | `true` | log decisions to plugin storage |
| `omoslimPath` / `omoslimPreset` | auto | override OMO-Slim config path / active preset |

## Backends

The picker tries backends in order and takes the first valid pick:

1. **`systemone`** (default) — the TypeSafe System One API shape:
   `POST {baseURL}/systemone` with `{model, state, questions}`.
   - Keyless on the OpenCode Zen gateway (`https://opencode.ai/inference/systemone/v1`, model `jev-1.13-free`).
   - Direct TypeSafe (`https://api.typesafe.ai/v1`, model `jev-latest`) with `apiKeyEnv: "TYPESAFE_API_KEY"`.
   - Any other System One-compatible endpoint (e.g. a self-hosted openJEV deployment that speaks the same shape).
2. **`chat`** — any OpenAI-compatible `/chat/completions` model asked to return
   `{"model": "...", "confidence": ..., "reason": "..."}`. Great for NVIDIA NIM,
   local llama.cpp, or an open Jev-style chat model:

```jsonc
"chat": { "providerID": "nvidia", "model": "z-ai/glm-5.3", "jsonMode": true }
```

Credentials for the `chat` backend are resolved from the OpenCode integration
store first (the same connection your provider already uses), then from
`auth.json`. Nothing else is read and nothing is ever logged.

## Tools

- **`jev_pick`** — explicit picking: `{ task, lane? }` → `{ model, probability, margin, reason }`. Handy in orchestrator prompts (see `prompts/orchestrator_append.md`).
- **`jev_status`** — diagnostics: backends, lanes and pins, candidate list, recent decisions.

## Policy & guarantees

- **Never blocks**: any failure path returns "no opinion" — delegation proceeds with its original model.
- **Explicit wins**: don't want a call touched? Pass `model` yourself (or set `policy.respectExplicitModel` as you prefer).
- **Validated**: a pick that isn't in the offered candidate list is discarded.
- **Bounded**: one decision call per delegation, cached, with a hard timeout.

## Privacy

The digest is the only task content that leaves your machine, and it's scrubbed
of key/token/secret-looking strings and long opaque blobs before sending. No
source code is included unless it's part of the delegation prompt text. Decision
logs live in local plugin storage.

## Development

```bash
bun install
bun test          # unit tests (no network)
bun run probe     # live smoke test: gateway models + one real Jev pick
bunx tsc --noEmit # typecheck
```

The plugin is loaded by OpenCode directly from TypeScript source, so there's no
build step. Two loading conventions exist:

- **Local checkout**: the config entry must be a **directory** (absolute path or
  `file://` URL). OpenCode probes `<dir>/server`, then `<dir>/index` — the root
  `server.ts` re-exports `src/index.ts` to satisfy the first probe. Absolute
  *file* paths are rejected with `configured plugin path must be a directory`.
- **npm package** (`"package": "jev-model-picker"`): the host resolves the
  `./server` subpath from `exports`, which also points at `src/index.ts`.

Config edits, and edits to the plugin's own files, hot-reload it in a running
OpenCode server — no restart needed.

## Roadmap

- Effort/variant picking (`#variant` suffixes) as a second decision question
- Per-lane cost ceilings and budget-aware policies
- Candidate filters (provider allow/deny lists) in config
- Multi-question Jev flows (noul gates for premium models)

## License

MIT — Jev and System One are by [TypeSafe](https://typesafe.ai); this project is
independent and unaffiliated.
