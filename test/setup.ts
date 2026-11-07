/**
 * Test preload: the single owner of JEV_MODEL_PICKER_STATE.
 *
 * Registered via bunfig.toml so it runs before ANY test file is imported.
 * Without it, each test file assigns the env var at module scope, so whichever
 * file imports last wins - and test/bridge.test.ts's afterEach deletes the
 * directory other files are writing decisions into. That race surfaced as
 * "readBridge defaults when the file is missing" intermittently receiving real
 * decisions (rev: 4 instead of 0).
 *
 * A preload fixes it once, deterministically, instead of per file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh, isolated directory per test run - never the user's live state.
const dir = mkdtempSync(join(tmpdir(), "jev-test-state-"));
process.env.JEV_MODEL_PICKER_STATE = dir;

// Clean up any directory a previous run leaked under the same prefix.
try {
  const prefix = "jev-test-state-";
  for (const entry of (await import("node:fs")).readdirSync(tmpdir())) {
    if (!entry.startsWith(prefix) || entry === dir.split(/[\\/]/).pop()) continue;
    const p = join(tmpdir(), entry);
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // a directory still held by another process is not ours to remove
    }
  }
} catch {
  // cleanup is best-effort; a leaked temp dir is harmless
}
