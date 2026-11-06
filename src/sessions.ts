import type { PickerRuntime } from "./pick";
import { recordDecisionToBridge } from "./bridge";

/**
 * Session-layer interception.
 *
 * The tool hook in src/hook.ts covers foreground delegations, but OpenCode's
 * *background* subagent path and OMO-Slim's revived/retained-task path do not
 * go through a tool call the picker can inspect: OMO spawns those children and
 * revives them through `session.promptAsync`, so a tool-only hook misses them
 * entirely.
 *
 * This layer watches `session.created` instead — every child session on this
 * host, however it was spawned — and applies the same decision Jev would have
 * made, via `ctx.session.switchModel`. It is the same mechanism OMO-Slim uses
 * to push a live preset change onto existing children, so it works for
 * background launches and revivals alike.
 *
 * Rules (deliberately conservative):
 *  - only sessions that belong to a known OMO-Slim lane are touched
 *  - if the child already has an explicit model that differs from the lane's
 *    preset pin, something chose on purpose (the tool hook, or the user) —
 *    record it and leave it alone
 *  - otherwise pick; a pick replaces the pin, no pick leaves the child on the
 *    pin (the fallback rule: never block)
 *  - every outcome is recorded in the bridge so the TUI can show which model
 *    was used instead of the preset's
 */

const MAX_TRACKED = 512;

type Applied = {
  ts: number;
  model: string;
  pin?: string;
  source: "jev" | "preset";
};

export async function registerSessionInterceptor(
  ctx: any,
  runtime: PickerRuntime,
): Promise<unknown> {
  const subscribe = ctx?.event?.subscribe;
  const switchModel = ctx?.session?.switchModel;

  const seen = new Set<string>();
  const applied = new Map<string, Applied>();

  function remember(sessionID: string, entry: Applied): void {
    applied.set(sessionID, entry);
    if (applied.size > MAX_TRACKED) {
      const oldest = applied.keys().next().value;
      if (oldest) applied.delete(oldest);
    }
  }

  function record(entry: {
    sessionID: string;
    lane: string;
    model: string;
    pin?: string;
    source: "jev" | "preset";
    pick?: any;
  }): void {
    try {
      recordDecisionToBridge({
        ts: Date.now(),
        sessionID: entry.sessionID,
        model: entry.model,
        defaultModel: entry.pin,
        probability: entry.pick?.probability ?? 0,
        margin: entry.pick?.margin ?? 0,
        reason:
          (entry.pick?.reason ?? "") ||
          (entry.source === "preset"
            ? "JEV declined — lane pin kept"
            : "session-layer pick"),
        backend: entry.pick?.backend ?? "session-layer",
        lane: entry.lane,
        task: entry.pick?.reason ?? `(session) ${entry.lane}`,
        pickedPrice: 0,
        defaultPrice: 0,
      });
    } catch {
      // recording is best-effort
    }
  }

  /**
   * Normalise the two real event payload shapes into one flat session record.
   *
   * Shape A (V2 / @opencode/protocol, `dist/groups/event.d.ts`): the event is
   *   `{ type: "session.created", data: { sessionID, parentID, agent, model, title, ... } }`
   * Shape B (legacy V1 emitter, OMO-Slim `index.js:82394-82405`): the event is
   *   `{ type: "session.created", properties: { info: { id, parentID, title, agent } } }`
   *
   * Consumers in the wild accept either (see OMO-Slim `index.js:82962`, which
   * does exactly this `event.data ?? event.properties ?? event` fallback), so
   * we do the same and then flatten a legacy `info` wrapper into the record.
   */
  function flattenSessionPayload(raw: any): any {
    let payload = raw;
    if (payload && typeof payload === "object") {
      const inner =
        payload.data && typeof payload.data === "object"
          ? payload.data
          : payload.properties && typeof payload.properties === "object"
            ? payload.properties
            : payload;
      payload = inner;
    }
    const info =
      payload && typeof payload === "object" && payload.info && typeof payload.info === "object"
        ? payload.info
        : undefined;
    if (!info) return payload ?? {};
    // Legacy shape: the session lives one level down inside `info`.
    return {
      ...payload,
      sessionID: payload.sessionID ?? info.id ?? info.sessionID,
      parentID: payload.parentID ?? info.parentID,
      agent: payload.agent ?? info.agent,
      model: payload.model ?? info.model,
      title: payload.title ?? info.title,
    };
  }

  /**
   * Decide and (when allowed) apply a model to a freshly created child
   * session. Returns what was finally in place.
   */
  async function handleSessionCreated(rawEvent: any): Promise<void> {
    try {
      const payload = flattenSessionPayload(rawEvent);
      const sessionID = String(payload?.sessionID ?? payload?.id ?? "");
      if (!sessionID || seen.has(sessionID)) return;
      seen.add(sessionID);
      if (seen.size > MAX_TRACKED * 4) seen.clear();

      const parentID = payload?.parentID ?? payload?.parentSessionID;
      if (!parentID) return; // root sessions keep the native model choice

      const agent = String(payload?.agent ?? "");
      const lanes = runtime.laneNames();
      if (!agent || (lanes.length > 0 && !lanes.includes(agent))) return;

      const pin = runtime.lanePin(agent);
      const current = payload?.model;
      const currentRef =
        current && typeof current === "object"
          ? `${current.providerID}/${current.id}`
          : typeof current === "string"
            ? current
            : undefined;

      // Someone already chose explicitly (the tool hook, or a user override).
      if (currentRef && pin && currentRef !== pin) {
        remember(sessionID, { ts: Date.now(), model: currentRef, pin, source: "jev" });
        record({
          sessionID,
          lane: agent,
          model: currentRef,
          pin,
          source: "jev",
        });
        return;
      }

      // Objective text. The real `session.created` payload carries `title` (see
      // @opencode/protocol dist/groups/event.d.ts: `data.title`); the legacy V1
      // emitter carries the same field inside `properties.info.title`. The other
      // names are kept as cheap forward-compatibility in case the host renames.
      // Only a short label is known at spawn time; when it is too thin for a
      // real digest, the lane name itself is the task. Jev declines and the
      // child keeps its pin — which is the correct fallback.
      const objective = String(
        payload?.title ??
          payload?.info?.title ??
          payload?.description ??
          payload?.label ??
          payload?.objective ??
          "",
      );
      const pick = await runtime.pick(
        agent,
        objective.length >= 16 ? objective : `work in the ${agent} lane`,
      );

      if (!pick) {
        remember(sessionID, { ts: Date.now(), model: pin ?? "", pin, source: "preset" });
        record({
          sessionID,
          lane: agent,
          model: pin ?? "",
          pin,
          source: "preset",
        });
        return;
      }

      if (typeof switchModel !== "function") {
        remember(sessionID, { ts: Date.now(), model: pick.ref, pin, source: "jev" });
        record({
          sessionID,
          lane: agent,
          model: pick.ref,
          pin,
          source: "jev",
          pick,
        });
        return;
      }

      try {
        await switchModel.call(ctx.session, {
          sessionID,
          model: { providerID: pick.ref.split("/")[0], id: pick.ref.split("/").slice(1).join("/") },
        });
        remember(sessionID, { ts: Date.now(), model: pick.ref, pin, source: "jev" });
        record({
          sessionID,
          lane: agent,
          model: pick.ref,
          pin,
          source: "jev",
          pick,
        });
      } catch {
        remember(sessionID, { ts: Date.now(), model: pin ?? pick.ref, pin, source: "preset" });
      }
    } catch {
      // a failure here must never disturb session creation
    }
  }

  if (typeof subscribe === "function") {
    try {
      const iterator = subscribe();
      const it = iterator?.[Symbol.asyncIterator]?.() ?? iterator;
      if (it && typeof it.next === "function") {
        let stopped = false;
        void (async () => {
          try {
            while (!stopped) {
              const next = await it.next();
              if (next?.done) break;
              const event = next.value;
              if (event?.type !== "session.created") continue;
              // flattenSessionCreated accepts the whole event and picks the
              // right payload shape, so pass it through untouched.
              await handleSessionCreated(event);
            }
          } catch {
            // the stream ends with the host; nothing to recover
          }
        })();
        return async () => {
          stopped = true;
          try {
            await it?.return?.();
          } catch {
            // ignore
          }
        };
      }
    } catch {
      // fall through to the prompt-hook fallback
    }
  }

  // Fallback: no event stream — use the session prompt hook, which still sees
  // every child before it starts working.
  const promptHook = ctx?.session?.hook;
  if (typeof promptHook === "function") {
    try {
      const registration = await promptHook("prompt", async (event: any) => {
        await handleSessionCreated({
          sessionID: event?.sessionID,
          parentID: event?.parentID,
          agent: event?.agent,
          model: event?.model,
          description: event?.description,
        });
      });
      return async () => {
        try {
          await registration?.dispose?.();
        } catch {
          // ignore
        }
      };
    } catch {
      // no interception surface available; the tool hook still covers foreground paths
    }
  }

  return async () => {};
}

/** Which model a session ended up with, and whether Jev chose it. */
export function appliedModel(
  history: Map<string, Applied>,
  sessionID: string,
): Applied | undefined {
  return history.get(sessionID);
}
