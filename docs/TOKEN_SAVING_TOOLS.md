# Token-saving tools — research findings

Researched 2026-11-07 by direct web search + verification against each repo's actual source
(`gh_grep` on the repos, not their READMEs). **All four tools below are real and have real OpenCode
adapter code** — verified by finding their OpenCode integration files, not by trusting the marketing.

## The four tools, ranked for *this* machine's measured problem

The measured waste is **cache-read dominance**: one lane burned 47,805,360 cache-read tokens against
1,480,113 input tokens (**32×**), plus **148 prompt-cache busts** in one session. So cost is
*carried context being re-read*, not output, not code volume. That ordering decides the ranking.

### 1. RTK — "Rust Token Killer" — `rtk-ai/rtk` (Apache-2.0)

Compresses terminal output before it reaches the context: command-specific filtering, grouping,
truncation, dedup, keeping errors/failures/changed files. Auto-rewrites shell calls so `git status`
becomes `rtk git status` with no agent cooperation.

- OpenCode support **verified in source**: `src/hooks/init/opencode.rs` installs an embedded plugin at
  `hooks/opencode/rtk.ts` that auto-rewrites calls.
- Claimed: **60–90% fewer command-output tokens** on supported commands (project-reported; and the
  claim is scoped to *terminal output only*, not the total bill).
- **Why it ranks first here**: bash/test/git output is exactly what bloats the fixer lane. Every token
  it removes is a token not carried and re-read every subsequent turn — it attacks the 32× ratio directly.
- Windows: **no Homebrew**, install is the shell script. Needs Rust to build from source.

### 2. Context Mode — `mksglu/context-mode`

Keeps bulky tool output *out* of the context window entirely, storing it in a local FTS5 index the agent
can re-query. Runs as an MCP server plus a hook adapter.

- OpenCode support **verified in source**: `src/adapters/opencode/index.ts` implements `HookAdapter`
  against `tool.execute.before` / `tool.execute.after`.
- Claimed: **315 KB → 5.4 KB (98%)** in one documented example (their workload, not a guarantee).
- **Why second**: same target as RTK — carried context — but it adds an MCP server and a search index,
  so more moving parts. Best for browser/MCP-heavy lanes; the user's lanes are mostly bash/read/write,
  where RTK is a better fit.

### 3. Ponytail — `DietrichGebert/ponytail` (MIT)

Stops over-engineering: a decision ladder that rules out stdlib, native platform features and existing
dependencies before writing new code. Keeps validation, security, accessibility and data-loss protection
out of the cutting.

- OpenCode support **verified in source**: `.opencode/plugins/ponytail.mjs` — injects the ruleset into
  every chat's system prompt, registers `/ponytail` commands and skills. npm-installable.
- Claimed: **54% less code, 22% fewer tokens** across 12 tasks (their benchmark).
- **Why third**: indirect. Smaller diffs mean less code to re-read later, which does help the 32× ratio,
  but it is a second-order effect. Also note the trade-off flagged by an independent benchmark:
  aggressive settings can sacrifice robustness on unstated edge cases.

### 4. Caveman — `JuliusBrussee/caveman`

Makes the agent say less: removes filler, hedges and narration, keeps code blocks, commands, API names
and exact errors. An optional local proxy also compresses eligible context before the request is sent.

- OpenCode support **verified in source**: `lib/opencode-agent.ts` and `bin/install.js` with
  `transformOpencodeAgentFrontmatter`.
- Claimed: **up to 65% fewer output tokens** (skill benchmark).
- **Why last**: the user's output is only 151K tokens against 47.8M cacheRead. **Output is not their
  bottleneck** — this is the wrong tool for their profile. The proxy half would help, but it is the most
  invasive option (it intercepts provider traffic), for the least direct gain.

## The gap none of the four cover — and where I can genuinely do better

**None of these four addresses prompt-cache busting, and the research is emphatic that it is the single
highest-value target.** The user has **148 busts in one session**; a bust discards the entire cached
prefix and pays full input price for it.

Verified findings on this:

- Prefixes must match **byte-for-byte** from the first token. A single changed character invalidates
  everything after it (mastra.ai; arxiv 2610.34817, "Silent and Costly: Characterizing and Detecting
  Prompt-Caching Mis-Integration in LLM Agents").
- The strongest published case: ProjectDiscovery's security agent ran 7% cache hit rate because its
  20,000-token system prompt contained **dynamic working memory that mutated as the agent worked**.
  Moving that dynamic block out of the system prompt and into the user turn fixed it.
- Measured reductions from fixing layout: **77%** (derivai, production agent), **80%** (gpt-5.4-mini,
  LangChain), **77%** (claude-haiku-4-5), **49%** (gemini-3.5-flash, implicit caching only).
- Effective prompt order: static instructions → shared dynamic context → conversation history → latest
  user message.
- Unstable JSON key ordering silently breaks the cache; coarsening a timestamp to date granularity
  preserves a stable prefix (a documented real fix in the arxiv paper).

**Why this matters for this specific setup, and why I can do better than installing anything:**

This machine runs a plugin architecture that mutates the prompt prefix on its own:
- `Jev`'s session-layer `switchModel` **changes the model mid-session**, which changes the prefix.
- OMO-Slim pushes live preset changes onto existing children (its own `switchModel` path).
- The user's config edits invalidate the prefix — every one of the ~35 plugin reloads observed in this
  session's logs was a guaranteed bust.
- Skill descriptions are re-listed every step; the SkillReducer study found **26.4% of skills have no
  routing description at all** and only **38.5% of skill body content is actionable**, while >60% is
  background/examples injected regardless of relevance.

So the highest-leverage work is not an install — it is making **Jev stop busting the cache**: pick once
per lane rather than per delegation, and avoid `switchModel` on a session that has already started
generating. That is a plugin change with a measurable before/after, and it attacks the exact metric the
user is losing on.

## Also worth knowing

**SkillReducer** (arxiv 2603.29919) is the OpenCode-specific paper. It studied 55,315 public skills and
delivers 48% description compression and 39% body compression **while improving functional quality by
2.8%** — a "less-is-more" effect. It was validated on **OpenCode v1.2.27** with 30 deployed skills. Its
tool is not released ("to be released upon acceptance"), so it is not installable — but its *findings*
are actionable now: audit installed skills and cut reference files that inject tokens unconditionally.

**Non-install findings that apply immediately:** keep instruction files small and stable (they sit in the
cached prefix); disable MCP servers not in use; start a fresh session when the task changes rather than
carrying history forward.

## Not installed, deliberately

Nothing from this list has been installed. All four are third-party code that hooks shell calls and tool
execution inside the user's live host, every percentage above is self-reported rather than independently
replicated, and two of them (RTK's shell rewriting, Caveman's traffic proxy) sit in the path of every
command the agent runs. Installing any of them needs the user's explicit go-ahead.
