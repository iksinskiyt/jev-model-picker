import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaneInfo } from "./types";

/**
 * Adapter for oh-my-opencode-slim (OMO-Slim): read the active preset and its
 * per-lane pinned models so we can (a) bias picks toward the lane's tier and
 * (b) know the fallback model when we don't pick.
 */

export interface OmoslimConfig {
  preset?: string;
  presets: Record<string, Record<string, LaneInfo>>;
}

export function parseOmoslim(text: string): OmoslimConfig | undefined {
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

    const presets: Record<string, Record<string, LaneInfo>> = {};
    const source =
      raw.presets && typeof raw.presets === "object" ? raw.presets : {};

    for (const [name, lanes] of Object.entries<any>(source)) {
      if (!lanes || typeof lanes !== "object") continue;
      const map: Record<string, LaneInfo> = {};
      for (const [lane, value] of Object.entries<any>(lanes)) {
        const model = typeof value?.model === "string" ? value.model : undefined;
        if (!model) continue;
        map[lane] = {
          model,
          variant: typeof value?.variant === "string" ? value.variant : undefined,
        };
      }
      presets[name] = map;
    }

    return {
      preset: typeof raw.preset === "string" ? raw.preset : undefined,
      presets,
    };
  } catch {
    return undefined;
  }
}

export function defaultOmoslimPath(): string {
  return join(homedir(), ".config", "opencode", "oh-my-opencode-slim.json");
}

export function loadOmoslim(path?: string): OmoslimConfig | undefined {
  const base = path && path.trim() ? path : defaultOmoslimPath();
  const candidates = [base];
  if (base.endsWith(".json")) candidates.push(`${base}c`);

  for (const file of candidates) {
    try {
      if (existsSync(file)) return parseOmoslim(readFileSync(file, "utf8"));
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
