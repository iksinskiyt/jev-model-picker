/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { bridgeFile, defaultState, readBridge, writeBridge } from "../bridge"
import type { BridgeDecision, BridgeState } from "../bridge"
import { existsSync, statSync } from "node:fs"

/**
 * TUI surface for jev-model-picker — the "JEV engaged" panel.
 *
 * - Sidebar (always visible): JEV on/off, the last pick with a probability
 *   bar, and a live savings estimate vs the OMO-Slim default models.
 * - Session panel (jev:panel): full decision history with probability bars.
 * - Palette commands: toggle, choose considered models, link a backend,
 *   open the history panel.
 *
 * Decisions are written by the server plugin into the shared bridge file
 * (src/bridge.ts); this plugin watches it and attributes family cost deltas
 * to each pick so "Saved $x" stays live.
 */

const PLUGIN_ID = "jev-model-picker"
const PANEL_NAME = `${PLUGIN_ID}.history`
const BAR_WIDTH = 18
const SAVINGS_POLL_MS = 1500
const BRIDGE_WRITE_DEBOUNCE_MS = 2000

function bar(fraction: number, width = BAR_WIDTH): string {
  const value = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  const filled = Math.round(value * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

function pct(fraction: number): string {
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%`
}

function money(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1000) return `${value < 0 ? "-" : "+"}$${(abs / 1000).toFixed(2)}k`
  if (abs >= 1) return `${value < 0 ? "-" : "+"}$${abs.toFixed(2)}`
  return `${value < 0 ? "-" : "+"}$${abs.toFixed(4)}`
}

function shortRef(ref: string): string {
  return ref.length > 38 ? `…${ref.slice(-37)}` : ref
}

export default Plugin.define({
  id: `${PLUGIN_ID}-tui`,
  async setup(ctx: Context) {
    const { ui, storage, keymap, data } = ctx
    const location = () => ctx.location ?? data.location.default()

    // ---------------------------------------------------------------- state

    // UI-local settings mirror the bridge so toggles survive reloads; the
    // bridge file is the source of truth the server reads.
    let bridge: BridgeState = readBridge()
    let lastMtime = 0
    try {
      if (existsSync(bridgeFile())) lastMtime = statSync(bridgeFile()).mtimeMs
    } catch {
      lastMtime = 0
    }

    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)

    const refresh = () => {
      try {
        const file = bridgeFile()
        if (!existsSync(file)) return
        const mtime = statSync(file).mtimeMs
        if (mtime === lastMtime) return
        lastMtime = mtime
        bridge = readBridge()
        bump()
      } catch {
        // ignore
      }
    }

    const persist = () => {
      try {
        writeBridge(bridge)
        if (existsSync(bridgeFile())) lastMtime = statSync(bridgeFile()).mtimeMs
      } catch {
        // ignore
      }
    }

    // -------------------------------------------------- savings attribution

    // For each pick we remember the family cost when it happened; any later
    // cost delta in that family multiplied by (1 - price ratio) is the
    // counterfactual saving of having picked the cheaper model.
    const baselines = new Map<number, number>()

    const attributeCosts = () => {
      let changed = false
      for (const decision of bridge.decisions) {
        if (!decision.sessionID) continue
        let current: number | undefined
        try {
          current = data.session.cost(decision.sessionID)
        } catch {
          continue
        }
        if (current === undefined) continue
        const previous = baselines.get(decision.ts)
        if (previous === undefined) {
          baselines.set(decision.ts, current)
          continue
        }
        const delta = current - previous
        if (delta > 0) {
          const ratio = Number.isFinite(decision.ratio) ? decision.ratio : 1
          decision.saved = (decision.saved ?? 0) + delta * (1 - ratio)
          baselines.set(decision.ts, current)
          changed = true
        }
      }
      return changed
    }

    let lastWrite = 0
    const poll = () => {
      refresh()
      if (attributeCosts() && Date.now() - lastWrite > BRIDGE_WRITE_DEBOUNCE_MS) {
        lastWrite = Date.now()
        persist()
        bump()
      }
    }

    onMount(() => {
      const timer = setInterval(poll, SAVINGS_POLL_MS)
      onCleanup(() => clearInterval(timer))
    })

    // ------------------------------------------------------------ commands

    const commands = () => [
      {
        id: `${PLUGIN_ID}.toggle`,
        title: "JEV: toggle assistance",
        description: bridge.enabled ? "Turn JEV model picking off" : "Turn JEV model picking on",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-toggle" },
        run: () => {
          bridge = readBridge()
          bridge.enabled = !bridge.enabled
          persist()
          bump()
          ui.toast.show({
            title: "JEV",
            message: bridge.enabled ? "assistance ON" : "assistance OFF",
            variant: bridge.enabled ? "success" : "warning",
          })
        },
      },
      {
        id: `${PLUGIN_ID}.models`,
        title: "JEV: choose considered models",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-models" },
        run: async () => {
          const models = (await data.location.model.list(location())) ?? []
          if (models.length === 0) {
            ui.toast.show({ title: "JEV", message: "no models available", variant: "warning" })
            return
          }
          const allow = async () => {
            const raw = (readBridge().settings?.allowlist as string[] | undefined) ?? []
            return raw.length ? raw : models.map((m: any) => m.id ?? `${m.providerID}/${m.modelID}`)
          }
          const selected = new Set(await allow())
          ui.dialog.show(() => (
            <ModelPicker
              models={models}
              selected={selected}
              onDone={(next) => {
                bridge = readBridge()
                bridge.settings = {
                  ...bridge.settings,
                  allowlist: next.length === models.length ? [] : next,
                }
                persist()
                bump()
                ui.dialog.clear()
                ui.toast.show({
                  title: "JEV",
                  message: next.length === models.length
                    ? "considering all models"
                    : `considering ${next.length} model(s)`,
                  variant: "success",
                })
              }}
            />
          ))
        },
      },
      {
        id: `${PLUGIN_ID}.link`,
        title: "JEV: link decision backend",
        description: "Host System One URL, or a local openJEV endpoint",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-link" },
        run: async () => {
          const baseURL = await ui.dialog.prompt({
            title: "Link JEV backend",
            description: "Base URL ending in /v1 — hosted System One or local openJEV",
            placeholder: "https://opencode.ai/inference/systemone/v1",
          })
          if (!baseURL) return
          const apiKey = await ui.dialog.prompt({
            title: "API key (optional)",
            description: "Leave empty for keyless backends",
          })
          const model = await ui.dialog.prompt({
            title: "Backend model (optional)",
            placeholder: "jev-1.13-free",
          })
          bridge = readBridge()
          bridge.settings = {
            ...bridge.settings,
            backend: {
              baseURL,
              apiKey: apiKey?.trim() || undefined,
              model: model?.trim() || undefined,
            },
          }
          persist()
          bump()
          ui.toast.show({ title: "JEV", message: `backend linked: ${baseURL}`, variant: "success" })
        },
      },
      {
        id: `${PLUGIN_ID}.panel`,
        title: "JEV: decision history (panel)",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-history" },
        run: () => {
          const route = ui.router.current()
          if (route.type !== "session") {
            ui.router.navigate({ type: "plugin", id: PLUGIN_ID, name: "history" })
            return
          }
          const opened = ui.panel.open(PANEL_NAME)
          if (!opened) {
            ui.router.navigate({ type: "plugin", id: PLUGIN_ID, name: "history" })
          }
        },
      },
    ]

    // mode "global" keeps the commands reachable while the palette itself
    // pushes its "modal" mode (a base-only layer would be unreachable).
    keymap.layer(() => ({
      mode: "global",
      commands: commands(),
    }))

    // -------------------------------------------------------------- widgets

    const lastPick = (): BridgeDecision | undefined => bridge.decisions[0]

    const savedTotal = () =>
      bridge.decisions.reduce((sum: number, d: BridgeDecision) => sum + (d.saved ?? 0), 0)

    ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        void version()
        const theme = ctx.theme
        const muted = theme?.text?.muted
        const base = theme?.text?.base
        const accent = theme?.hue?.accent?.[200] ?? base
        const last = lastPick()
        const saved = savedTotal()
        return (
          <box flexDirection="column" gap={1}>
            <text fg={base} attributes={TextAttributes.BOLD}>
              {`JEV ${bridge.enabled ? "ON" : "OFF"}`}
            </text>
            <Show when={last} fallback={<text fg={muted}>no picks yet</text>}>
              {(pick: () => BridgeDecision) => (
                <>
                  <text fg={base}>{`picked ${shortRef(pick().model)}`}</text>
                  <text fg={accent}>{`${bar(pick().probability)} ${pct(pick().probability)}`}</text>
                  <Show when={pick().lane}>
                    <text fg={muted}>{`lane: ${pick().lane}`}</text>
                  </Show>
                </>
              )}
            </Show>
            <Show when={saved !== 0}>
              <text fg={saved > 0 ? accent : muted}>{`saved ~${money(saved)}`}</text>
            </Show>
            <text fg={muted}>{`session ${sessionID.slice(0, 8)}`}</text>
          </box>
        )
      },
    })

    const historyBody = () => (
      <box flexDirection="column" gap={1}>
        <Show
          when={bridge.decisions.length > 0}
          fallback={<text fg={ctx.theme?.text?.muted}>No JEV decisions recorded yet.</text>}
        >
          <For each={bridge.decisions.slice(0, 60)}>
            {(decision: BridgeDecision) => (
              <box flexDirection="column">
                <text fg={ctx.theme?.text?.base}>
                  {`${bar(decision.probability)} ${pct(decision.probability)}  ${shortRef(decision.model)}`}
                </text>
                <text fg={ctx.theme?.text?.muted}>
                  {[
                    decision.reason,
                    decision.lane ? `lane ${decision.lane}` : "",
                    decision.backend,
                    new Date(decision.ts).toLocaleTimeString(),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    )

    // Session panel: mounted by the host while a panel is open, so gate every
    // render on the selected panel name (the host sets panel.name).
    ui.slot({
      append: "session.panel",
      render: (panel: PanelInput) => (
        <Show when={panel.name === PANEL_NAME}>
          <box flexDirection="column" gap={1}>
            <text fg={ctx.theme?.text?.base} attributes={TextAttributes.BOLD}>
              {`JEV history — saved ~${money(savedTotal())}`}
            </text>
            {historyBody()}
          </box>
        </Show>
      ),
    })

    const unregisterRoute = ui.router.register({
      name: "history",
      render: () => (
        <box flexDirection="column" gap={1}>
          <text fg={ctx.theme?.text?.base} attributes={TextAttributes.BOLD}>
            JEV decision history
          </text>
          {historyBody()}
        </box>
      ),
    })

    // ------------------------------------------------------------- picker UI

    function ModelPicker(props: {
      models: readonly any[]
      selected: Set<string>
      onDone: (next: string[]) => void
    }) {
      const refs = () =>
        props.models.map((m: any) => m.id ?? `${m.providerID}/${m.modelID}`)
      const [cursor, setCursor] = createSignal(0)
      const [chosen, setChosen] = createSignal(new Set(props.selected))
      const theme = ctx.theme
      keymap.layer(() => ({
        mode: "global",
        commands: [
          { bind: "up", run: () => setCursor((i) => Math.max(0, i - 1)) },
          { bind: "down", run: () => setCursor((i) => Math.min(refs().length - 1, i + 1)) },
          {
            bind: "space",
            run: () => {
              const ref = refs()[cursor()]
              setChosen((prev) => {
                const next = new Set(prev)
                if (next.has(ref)) next.delete(ref)
                else next.add(ref)
                return next
              })
            },
          },
          {
            bind: "return",
            run: () => props.onDone([...chosen()]),
          },
          {
            bind: "escape",
            run: () => ui.dialog.clear(),
          },
        ],
      }))
      const visible = () => {
        const height = ctx.renderer.height ?? 24
        const start = Math.max(0, Math.min(cursor() - Math.floor(height / 2), refs().length - height + 2))
        const end = Math.min(refs().length, start + height - 4)
        return refs()
          .map((ref: string, index: number) => ({ ref, index }))
          .slice(start, Math.max(end, start + 1))
      }
      return (
        <box flexDirection="column" gap={0}>
          <text fg={theme?.text?.base} attributes={TextAttributes.BOLD}>
            {`Models JEV may consider (${chosen().size}/${refs().length})`}
          </text>
          <For each={visible()}>
            {({ ref, index }: { ref: string; index: number }) => (
              <text
                fg={index === cursor() ? theme?.hue?.accent?.[200] ?? theme?.text?.base : theme?.text?.muted}
                attributes={index === cursor() ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {`${chosen().has(ref) ? "[x]" : "[ ]"} ${shortRef(ref)}`}
              </text>
            )}
          </For>
          <text fg={theme?.text?.muted}>space toggle · enter save · esc cancel</text>
        </box>
      )
    }

    return () => {
      unregisterRoute()
    }
  },
})
