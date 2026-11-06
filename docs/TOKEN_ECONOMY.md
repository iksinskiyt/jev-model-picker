# Token economy — what to install and what to change

Researched 2026-11-06. Two independent sources: the local OpenCode source tree
(`F:\code\opencode\packages`, authoritative for which config keys exist) and the published OpenCode docs.
Third-party skill/plugin claims were **checked against the local schema before being recommended**, and one
recommendation from that research was discarded as false.

## Verified config wins — applied to `~/.config/opencode/opencode.jsonc`

Keys confirmed present in the local source (`packages/core/src/config` +
`packages/core/test/config/config.test.ts:1573-1578,1548`):

```jsonc
"compaction": { "auto": true, "keep": { "tokens": 10000 }, "buffer": 25 },
"tool_output": { "max_lines": 800, "max_bytes": 24000 },
"media": { "image": { "auto_resize": true, "max_width": 1280, "max_height": 960,
                      "max_base64_bytes": 500000 } }
```

Why each, against the measured waste (fixer: 47.8M cacheRead vs 1.5M input = 32×):

- **`keep.tokens`** — every retained token is re-read on every subsequent request, so this directly scales
  the dominant cost. 10k is a deliberate compromise: lower is cheaper but makes the agent re-explore, which
  costs more than it saves.
- **`buffer: 25`** — compact earlier so the summary pass runs before the window fills instead of an emergency
  compaction mid-task.
- **`tool_output`** — one verbose `read` or `bash` result can dominate a whole step.
- **`media.image`** — the designer/observer lanes are screenshot-driven, and one full-resolution image is the
  largest single context item.

**Rejected keys** (the local source is explicit):
- `compaction.prune` and `compaction.tail_turns` — `config/normalize.ts:352-353` marks both unsupported.
- `experimental.background_compaction` — **zero references anywhere in the local source.** A research lane
  recommended it as a "priority 3"; it would be silently ignored. This is the failure mode to watch for with
  any doc-only recommendation.

## Skills: what is real

OpenCode's skill system is **lazy-loading by design** — at each step only `id`/`name`/`description` are listed,
and the body loads only when the agent calls `skill`. So adding a skill costs only its description line unless
it is invoked. The corollary is that *installing a pile of skills raises the per-request floor*, which argues
against "install an awesome-list".

Install locations that the local source accepts (`skills: ["./skills", "~/shared-skills", "https://…"]`):
- global: `C:\Users\mak0114\.config\opencode\skills\<id>\SKILL.md`
- project: `F:\code\jev-model-picker\.opencode\skills\<id>\SKILL.md`

**Not installed, deliberately** — unverified provenance and tiny/young repos:

| Candidate | Claim | Why not installed |
|---|---|---|
| `context-manager` (github.com/TMFNK) | 4-layer memory, "89% token savings" | 1 star, created 2026-03; the 89% figure is the author's own benchmark on retrieval, not on a coding workflow |
| `token-saver-opencode` (github.com/otnc) | lean-work rules | 6 stars, first seen 2026-09; the rules duplicate what Jev's own lane prompts already enforce |
| `@chenlongapps/opencode-token-usage` | per-session token breakdown | genuinely useful for diagnosis, but it is a third-party plugin that runs in the host — needs the user's go-ahead |
| "awesome-opencode-skills" lists | collections | would *raise* the per-request baseline |

**Not installable at all**: SkillReducer (arxiv 2603.29919) is a paper, not a tool.

## What already covers the same ground

The biggest structural win is not a skill — it is that the *orchestrator never sees the delegated output*. Jev
hands work to a subagent, the subagent's tool results stay in the child session, and only its final answer comes
back. That is already the architecture, and no installed skill improves on it.

The one genuinely additive thing a plugin could give is **visibility**: which lane and which tool produced the
47.8M cache-read. Jev records decisions but not per-lane token attribution, so that gap is currently filled by
reading `session_v2` by hand.

## Live config note (not a code bug)

`providers.nvidia.models` in `opencode.jsonc` still advertises two models measured as unusable —
`z-ai/glm-5.3-flash` (240s timeouts) and `nvidia/nemotron-3.5-lightning-30b-a3b` (empty responses). Jev
excludes both at scoring time (`KNOWN_BAD_MODELS` / `KNOWN_EMPTY_MODELS`), so they cannot be picked, but the
catalog still offers them to anything that does not go through Jev. Removing the entries is belt-and-braces,
not a fix.
