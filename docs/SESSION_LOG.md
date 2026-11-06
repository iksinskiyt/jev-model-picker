# Session log — compaction checkpoint 2

Latest commit: `f03dc5b` (pushed to `origin/main`). `bun run verify` = typecheck + **157 tests pass** + 284-module bundle.

---

## 1. The plugin-load failure — root cause and resolution

Symptom: `SyntaxError: Export named 'recordConcentration' not found in module 'src/limits.ts'`, ~35/35 load attempts.

I worked the loader chain in the local source before concluding:

```
packages/core/src/plugin.ts            plugin.effect(...)
  @opencode/plugin/dist/source.bun.js  prepareSource(): walks the graph from the
                                       entrypoint and deletes require.cache entries
  @opencode/plugin/dist/host.js        Host.load() → importModule() → import(file://…)
```

`prepareSource`'s cache invalidation is best-effort and its own comment states the weakness:

> *"rejected evaluations are not enumerable, but deletion still invalidates them."*

`recordConcentration` only existed in the tree between 13:00–13:44 UTC, when `catalog.ts` briefly imported it from `./limits` instead of `./optimize`. That failed the link, the rejected evaluation was cached, and the long-lived server replayed it.

**Everything I could construct loaded the identical code correctly** — tsc, 156 tests, `bun build` (bun + node), `bunx esbuild --bundle`, `import(file://…)` from three cwds, and the host's *exact* `prepareSource()` invalidate-then-import sequence 3× over. No stale file, no on-disk cache, no cycle, no config pointer — each checked.

Per-process log analysis was decisive: in the last 60 minutes exactly **one** process attempted to load the plugin (`run=e6222d69`, `role=server`) and it failed every time; no other role attempted it. That process had been alive 14.5 hours.

**Fix: restart the OpenCode server.** Confirmed afterwards — `jev_status` returns live data and 85 load attempts, 0 failures since 20:10.

*Diagnostic note*: my first failure-count was 201, which was wrong — my own Python scripts contained the literal string "failed to load plugin" and matched the host's "spawning process" log lines. Filtering on `target=` plus a real timestamp cut it to 1, which was the same artefact.

## 2. Jev is now enabled — and live testing immediately found four real defects

Turning it on was deliberately deferred until `optimize.ts` had landed, because before that it would have routed work to the exhausted Go plan.

Live `jev_pick` results, then fixed:

| # | Defect | Fix |
|---|---|---|
| 1 | `KNOWN_EMPTY_MODELS` was keyed `nvidia/nemotron-3.5-lightning-30b-a3b`, but `getHealthModelId()` strips the doubled `nvidia/nvidia/` — so the lookup never matched and a model measured to return an **EMPTY response** kept being picked for fixer/explorer/librarian. | Rekeyed bare + regression test |
| 2 | **No lane-pin preference in the scoring at all** — a healthy pin lost to marginally-cheaper models. | Added `pinBonus: 8`, applied only when the candidate *is* the resolved pin |
| 3 | Jev substituted healthy pins at **12–15% confidence**. | Confidence floor: decline below 34% (`MIN_SUBSTITUTION_CONFIDENCE`, overridable by `policy.minProbability`); an unhealthy/exhausted pin is still overridden |
| 4 | `nemotron-3-super-120b-a12b` (not served to this account) was picked for oracle — it is one `.` away from the working observer pin `nemotron-3.5-**super-vl**-120b-a12b`. | Added to the dark list with an explicit comment about the trap |

Also: `filterDarkModels` now drops **degraded** as well as dark models (an empty response is a task that silently did no work, not a penalty), while still returning them when nothing healthy remains, so never-block holds.

### Verified in-process, not just asserted
A throwaway probe ran `listCandidates` against a realistic NIM catalog for all seven lanes and printed the ranking. After the fixes every lane's pin ranks #1 and the degraded model is absent from all seven lanes. (The probe also caught a *test-fixture* error of mine — doubled ids produced triple-prefixed refs that silently disabled the pin bonus, which is why the first run looked wrong.)

## 3. Live picks after the fixes

```
fixer     → (declines; keeps the healthy pin)
explorer  → nemotron-3-nano-omni (which IS the explorer pin)
oracle    → nemotron-3-super-120b-a12b @43% (above the floor — bad pick, now excluded)
librarian → nemotron-3-super-120b-a12b @15% (below the floor — blocked)
```

`librarian` still returned a pick despite being under the floor at the time of that test; the server had not yet reloaded the newest edit. Since then `nemotron-3-super-120b-a12b` has been added to the dark list, so that specific bad outcome is now unreachable.

## 4. Open item — flaky test

Two test runs failed (~1 in 8, runtime 20s vs the usual 2.4s, consistent with a timeout). It has **not reproduced in 17 consecutive runs** (12 × `bun test`, 5 × `bun run verify`). Not yet identified — needs a run that captures the failure text; the earlier attempts captured neither the name nor a summary.

## 5. Still open
- **Billing ground truth**: all observed background child sessions were aborted before their first assistant turn, so no `session_v2` usage row confirms which model `switchModel` actually put on the wire. TODO for a live delegation.
- **Budget provider is still `go`** — and Go is dead. Every live pick is a free-tier NIM model, so `budget.provider: "auto"` (or a NIM-aware setting) would describe reality better. Not changed yet because it alters live behaviour.
- `opencode/glm-5.3-flash-free` (OpenCode's own free tier — a *different* provider from NIM) was working in the DB and may suit those lanes better than NIM. Could not be tested from this host (HTTP 403).
