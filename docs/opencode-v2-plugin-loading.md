# OpenCode V2 plugin loading — verified notes

Where the plugin lives, how OpenCode finds it, and how it hot-reloads. Verified
against `opencode` source (`packages/core/src/config/plugin/source.ts`,
`packages/core/src/plugin/module.ts`, `packages/plugin/src/host.ts`) at
`@opencode/plugin` **2.0.32**, and end-to-end against a running v2.0.32 server.

## Config entry resolution

Entries under the `plugins` config key may be:

- a string — npm name, absolute path, `file://` URL, or `./relative` path
  (resolved against the config file's directory);
- an object — `{ "package": "<same forms>", "options": { … } }` — the form this
  plugin uses for its own options;
- a string starting with `-` — removes a previously configured/discovered entry.

Absolute paths must be **directories**:

- `path` is a file → `WARN configured plugin path must be a directory` and the
  entry is **silently dropped**;
- `path` is a directory → entrypoints are probed in this order:
  `<dir>/server`, then `<dir>/index` (Bun resolution — `.ts` works, no
  package.json required). No entrypoint found → entry is **silently dropped**.
- The resolved `server` entrypoint must live **inside** the directory.

npm packages resolve `pkg/server` first — i.e. the package's
`exports["./server"]` subpath — falling back to the package main export.

There is one legacy exception: a *config* file path (not directory) is allowed
by the loader itself for standalone server sources, but the config scanner
drops it before it gets there — so in practice: **always point at a directory**.

## Entrypoint trio

`Host.resolve` returns up to three entrypoints: `server`, `tui`, `rpc`.
Only `server` matters for delegation hooks, tools, and storage. A directory can
be TUI-only (useful for UI extensions) — not this plugin's case.

## Loading and hot reload

- **Local directory** plugins load through the source runtime
  (`source.bun.ts`): a Bun transpiler import-graph scan of the entrypoint, with
  `require.cache` invalidation and native re-import on each reload. Every file
  in the graph is watched, as is the configured directory itself — **editing the
  plugin's files hot-reloads it in a running server**. No restart, no build.
- **npm package** plugins load via `Host.load(entrypoint)` with the npm revision
  recorded, so installs update on config re-scan.

## Isolating a test instance

Useful when testing a plugin against a cloned/dev OpenCode without touching a
live install:

| env var | effect |
| --- | --- |
| `OPENCODE_CONFIG_DIR` | config directory (plugins, agents, …) |
| `XDG_DATA_HOME` | data root → `opencode.db`, `log/`, `auth.json` |
| `XDG_CACHE_HOME` | cache root → npm-installed plugins, binaries |
| `XDG_STATE_HOME` / `OPENCODE_TEST_HOME` | state / home overrides |

`opencode run --standalone` starts a private in-process server;
`--print-logs` surfaces its logs on stderr (server logs require `--standalone`).

## This repo's layout, and why

- Root `server.ts` re-exports `src/index.ts` → satisfies the `<dir>/server`
  probe for **local-directory** installs.
- `exports["./server"]` → `./src/index.ts` → satisfies `pkg/server` for
  **npm-package** installs.
- Both paths load the same TypeScript source; there is no build step.
