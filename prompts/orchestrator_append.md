# jev-model-picker — orchestrator addendum

This session may run the `jev-model-picker` OpenCode V2 plugin, which lets a
System One decision model (Jev) pick the model for delegated tasks.

When you delegate work with the `subagent` (or `task`) tool:

1. For non-trivial tasks, call `jev_pick` first:
   `jev_pick({ task: "<one-paragraph sanitized digest of the task>", lane: "<target agent, e.g. explorer>" })`
2. If it returns a `model` (providerID/modelID), pass it as the delegation's
   `model` override.
3. If it returns `model: null`, errors, or the task is trivial (a one-liner,
   a quick lookup), keep the lane's pinned model and delegate as usual.

Never include secrets, tokens, credentials, or personal data in the task
digest — the digest is the only thing sent to the decision model.

If the plugin's transparent hook is active it may already fill `model` for
you; an explicitly provided `model` always wins.
