import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Credential resolution for chat backends: prefer the OpenCode integration
 * connection store (ctx.integration), fall back to the local auth.json.
 * Never logs or returns anything beyond the raw key string.
 */

function extractKey(credential: any): string | undefined {
  if (!credential) return undefined;
  if (typeof credential === "string") return credential;
  for (const field of [
    "key",
    "apiKey",
    "api_key",
    "access",
    "accessToken",
    "access_token",
    "token",
    "value",
  ]) {
    const value = credential[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export async function resolveIntegrationKey(
  ctx: any,
  providerID: string,
): Promise<string | undefined> {
  try {
    const connection = await ctx?.integration?.connection?.active?.(providerID);
    if (!connection) return undefined;
    const credential = await ctx.integration.connection.resolve(connection);
    return extractKey(credential);
  } catch {
    return undefined;
  }
}

function readAuthJsonKey(providerID: string): string | undefined {
  try {
    const path = join(
      homedir(),
      ".local",
      "share",
      "opencode",
      "auth.json",
    );
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return extractKey(raw?.[providerID]);
  } catch {
    return undefined;
  }
}

export async function resolveProviderKey(
  ctx: any,
  providerID: string,
): Promise<string | undefined> {
  const fromIntegration = await resolveIntegrationKey(ctx, providerID);
  if (fromIntegration) return fromIntegration;
  return readAuthJsonKey(providerID);
}
