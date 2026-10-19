/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { bridgeFile, readBridge, writeBridge } from "../bridge"
import type { BridgeDecision, BridgeState } from "../bridge"
import { existsSync, statSync } from "node:fs"

/**
 * TUI surface for jev-model-picker.
 *
 * Probability bars live in the session transcript (the server appends them to
 * each delegated tool result — see src/hook.ts). This plugin renders:
 * - a clickable right-sidebar occupancy block: a JEV ON/OFF button, the last
 *   pick, and a click-anywhere-open history action,
 * - the history as message-like blocks (same SplitBorder look as session
 *   messages) in a session panel and a route page,
 * - palette commands: toggle, model allow-list picker (paged), backend linker.
 */

const PLUGIN_ID = "jev-model-picker"
const PANEL_NAME = `${PLUGIN_ID}.history`
const SAVINGS_POLL_MS = 1500
const BRIDGE_WRITE_DEBOUNCE_MS = 2000
const MINI_BAR_WIDTH = 10
const HISTORY_BAR_WIDTH = 24
const PICKER_PAGE_ROWS = 11

function bar(fraction: number, width: number): string {
  const value = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  const filled = Math.round(value * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

// Same left-rail the session transcript uses for message blocks.
const SplitBorder = {
  border: ["left" as const],
  customBorderChars: {
    topLeft: "",
    bottomLeft: "",
    topRight: "",
    bottomRight: "",
    vertical: "┃",
    horizontal: " ",
    bottomT: "",
    topT: "",
    cross: "",
    leftT: "",
    rightT: "",
  },
}

function shortRef(ref: string, width = 26): string {
  return ref.length > width ? `…${ref.slice(-(width - 1))}` : ref.padEnd(width)
}

type Price = { ref: string; provider: string; pricePerMTok: number }

function priceOf(model: any): Price {
  const provider = String(model?.providerID ?? model?.provider?.id ?? "?")
  const id = String(model?.id ?? model?.modelID ?? "")
  const ref = model?.id ?? (id ? `${provider}/${id}` : "")
  const tiers: any[] = Array.isArray(model?.cost) ? model.cost : []
  const tier = tiers[0]
  const input = Number(tier?.input ?? 0)
  const output = Number(tier?.output ?? 0)
  const pricePerMTok =
    Number.isFinite(input) && Number.isFinite(output) ? (input + output) / 2 : 0
  return { ref, provider, pricePerMTok }
}

function priceLabel(price: number): string {
  if (price <= 0) return "free"
  if (price >= 100) return `$${price.toFixed(0)}/MTok`
  return `$${price.toFixed(2)}/MTok`
}

/** Clickable terminal button; ignores drags that select text. */
function Button(props: { label: string; onClick: () => void; children?: any }) {
  const theme = useThemeSafe()
  const [hovered, setHovered] = createSignal(false)
  return (
    <box
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={hovered() ? theme.hovered : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={() => {
        const selection = ctxRendererSelection()
        if (selection) return
        props.onClick()
      }}
    >
      <text fg={theme.base} attributes={TextAttributes.BOLD}>
        {props.label}
      </text>
    </box>
  )
}

let pluginCtx: Context
function ctxRendererSelection(): string | undefined {
  try {
    return pluginCtx?.renderer?.getSelection?.()?.getSelectedText?.() || undefined
  } catch {
    return undefined
  }
}
function useThemeSafe() {
  const theme = pluginCtx?.theme
  return {
    base: theme?.text?.base,
    hovered: theme?.background?.action?.primary?.hovered ?? theme?.hue?.accent?.[300],
  }
}

export default Plugin.define({
  id: `${PLUGIN_ID}-tui`,
  async setup(ctx: Context) {
    const { ui, keymap, data } = ctx
    pluginCtx = ctx
    const location = () => ctx.location ?? data.location.default()

    // ---------------------------------------------------------------- state

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

    // ------------------------------------------------------------- commands

    const toggleEnabled = () => {
      bridge = readBridge()
      bridge.enabled = !bridge.enabled
      persist()
      bump()
      ui.toast.show({
        title: "JEV",
        message: bridge.enabled ? "assistance ON" : "assistance OFF",
        variant: bridge.enabled ? "success" : "warning",
      })
    }

    const openHistory = () => {
      const route = ui.router.current()
      if (route.type !== "session") {
        ui.router.navigate({ type: "plugin", id: PLUGIN_ID, name: "history" })
        return
      }
      const opened = ui.panel.open(PANEL_NAME)
      if (!opened) ui.router.navigate({ type: "plugin", id: PLUGIN_ID, name: "history" })
    }

    const commands = () => [
      {
        id: `${PLUGIN_ID}.toggle`,
        title: "JEV: toggle assistance",
        description: bridge.enabled ? "Turn JEV model picking off" : "Turn JEV model picking on",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-toggle" },
        run: toggleEnabled,
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
          const prices = models.map(priceOf)
          const allow = () => {
            const raw = (readBridge().settings?.allowlist as string[] | undefined) ?? []
            return raw.length ? new Set(raw) : new Set(prices.map((p) => p.ref))
          }
          // Standard dialog size, with the picker's own paging inside it.
          ui.dialog.set({ size: "medium" })
          ui.dialog.show(() => (
            <ModelPicker
              models={prices}
              selected={allow()}
              onDone={(next) => {
                bridge = readBridge()
                bridge.settings = {
                  ...bridge.settings,
                  allowlist: next.size === prices.length ? [] : [...next],
                }
                persist()
                bump()
                ui.dialog.clear()
                ui.toast.show({
                  title: "JEV",
                  message: next.size === prices.length
                    ? "considering all models"
                    : `considering ${next.size} model(s)`,
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
        run: openHistory,
      },
    ]

    // mode "global" keeps commands reachable while the palette pushes "modal".
    keymap.layer(() => ({
      mode: "global",
      commands: commands(),
    }))

    // -------------------------------------------------------------- sidebar

    const savedTotal = () =>
      bridge.decisions.reduce((sum: number, d: BridgeDecision) => sum + (d.saved ?? 0), 0)

    const HistoryPanel = (props: { panel?: PanelInput }) => (
      <box flexDirection="column" gap={1}>
        <text fg={ctx.theme?.text?.base} attributes={TextAttributes.BOLD}>
          {`JEV history · saved $${savedTotal().toFixed(4)}`}
        </text>
        {historyBody()}
      </box>
    )

    // Right sidebar: occupancy only — a toggle button, the last pick, and the
    // whole block opens the history on click.
    ui.slot({
      append: "sidebar.content",
      render: () => {
        void version()
        const theme = ctx.theme
        const base = theme?.text?.base
        const muted = theme?.text?.muted
        const accent = theme?.hue?.accent?.[200] ?? base
        const last = bridge.decisions[0]
        const saved = savedTotal()
        return (
          <box flexDirection="column" gap={0}>
            <Button
              label={` JEV ${bridge.enabled ? "ON" : "OFF"} ▸ `}
              onClick={toggleEnabled}
            />
            <box
              flexDirection="column"
              onMouseUp={() => {
                if (ctxRendererSelection()) return
                openHistory()
              }}
            >
              <Show when={last} fallback={<text fg={muted}>waiting for a delegated task</text>}>
                {(pick: () => BridgeDecision) => (
                  <>
                    <text fg={base}>
                      {`${shortRef(pick().model, 18)} ${(pick().probability * 100).toFixed(0)}% ${bar(
                        pick().probability,
                        MINI_BAR_WIDTH,
                      )}`}
                    </text>
                    <text fg={muted}>{`lane ${pick().lane || "-"} · click for history`}</text>
                  </>
                )}
              </Show>
            </box>
            <text fg={saved >= 0 ? accent : muted} attributes={TextAttributes.BOLD}>
              {`saved $${saved.toFixed(4)}`}
            </text>
          </box>
        )
      },
    })

    // ------------------------------------------------------- history blocks

    /** One decision rendered like a transcript message: role header + verdict. */
    function historyEntry(decision: BridgeDecision) {
      const theme = ctx.theme
      const base = theme?.text?.base
      const muted = theme?.text?.muted
      const accent = theme?.hue?.accent?.[200] ?? base
      const when = new Date(decision.ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      const details = [
        decision.reason,
        decision.lane ? `lane ${decision.lane}` : "",
        decision.backend,
        decision.saved !== undefined ? `saved ${decision.saved >= 0 ? "+" : "-"}$${Math.abs(decision.saved).toFixed(4)}` : "",
        when,
      ].filter(Boolean)
      return (
        <box {...SplitBorder} borderColor={accent} paddingLeft={1} flexDirection="column" gap={0}>
          <text fg={base} attributes={TextAttributes.BOLD}>
            {`▸ ${decision.lane || "delegated task"} · ${when}`}
          </text>
          <text fg={base}>{`JEV picked ${shortRef(decision.model, 34)}`}</text>
          <text fg={accent}>
            {`${bar(decision.probability, HISTORY_BAR_WIDTH)} ${(decision.probability * 100).toFixed(1)}%`}
          </text>
          <Show when={decision.defaultModel}>
            <text fg={muted}>{`default ${shortRef(decision.defaultModel!, 30)}`}</text>
          </Show>
          <text fg={muted}>{details.join(" · ")}</text>
        </box>
      )
    }

    function historyBody() {
      return (
        <box flexDirection="column" gap={1}>
          <Show
            when={bridge.decisions.length > 0}
            fallback={<text fg={ctx.theme?.text?.muted}>No JEV decisions recorded yet.</text>}
          >
            <For each={bridge.decisions.slice(0, 60)}>
              {(decision: BridgeDecision) => historyEntry(decision)}
            </For>
          </Show>
        </box>
      )
    }

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

    // Session panel — mounted while a panel is open; gate on the selected name.
    ui.slot({
      append: "session.panel",
      render: (panel: PanelInput) => (
        <Show when={panel.name === PANEL_NAME}>
          <HistoryPanel />
        </Show>
      ),
    })

    // ------------------------------------------------------------- picker UI

    function ModelPicker(props: {
      models: readonly Price[]
      selected: Set<string>
      onDone: (next: Set<string>) => void
    }) {
      type Row =
        | { kind: "provider"; provider: string; refs: string[] }
        | { kind: "model"; ref: string; provider: string; pricePerMTok: number }

      const providers = [...new Set(props.models.map((p) => p.provider))].sort()
      const ordered: Row[] = []
      for (const provider of providers) {
        const refs = props.models.filter((p) => p.provider === provider).map((p) => p.ref)
        ordered.push({ kind: "provider", provider, refs })
        for (const ref of refs) {
          const entry = props.models.find((p) => p.ref === ref)!
          ordered.push({ kind: "model", ref, provider, pricePerMTok: entry.pricePerMTok })
        }
      }

      const [cursor, setCursor] = createSignal(0)
      const [chosen, setChosen] = createSignal(new Set(props.selected))
      const [freeOnly, setFreeOnly] = createSignal(false)
      let beforeFreeOnly = new Set(props.selected)
      const freeRefs = props.models.filter((p) => p.pricePerMTok <= 0).map((p) => p.ref)
      const refWidth = Math.min(30, Math.max(...props.models.map((p) => p.ref.length)) + 1)
      const pages = () => Math.max(1, Math.ceil(ordered.length / PICKER_PAGE_ROWS))
      const page = () => Math.floor(cursor() / PICKER_PAGE_ROWS)

      const move = (delta: number) =>
        setCursor((i) => Math.max(0, Math.min(ordered.length - 1, i + delta)))
      const gotoPage = (delta: number) => {
        const next = Math.max(0, Math.min(pages() - 1, page() + delta))
        setCursor(next * PICKER_PAGE_ROWS)
      }

      const toggleRow = () => {
        const row = ordered[cursor()]
        if (!row) return
        if (row.kind === "provider") {
          setChosen((prev) => {
            const next = new Set(prev)
            const allOn = row.refs.every((ref) => next.has(ref))
            for (const ref of row.refs) {
              if (allOn) next.delete(ref)
              else next.add(ref)
            }
            return next
          })
          return
        }
        if (freeOnly() && row.pricePerMTok > 0) {
          ui.toast.show({ title: "JEV", message: "free-only is ON — paid models locked", variant: "warning" })
          return
        }
        setChosen((prev) => {
          const next = new Set(prev)
          if (next.has(row.ref)) next.delete(row.ref)
          else next.add(row.ref)
          return next
        })
      }

      keymap.layer(() => ({
        mode: "global",
        commands: [
          { bind: "up", run: () => move(-1) },
          { bind: "down", run: () => move(1) },
          { bind: "left", run: () => gotoPage(-1) },
          { bind: "right", run: () => gotoPage(1) },
          { bind: "space", run: toggleRow },
          {
            bind: "f",
            run: () => {
              setFreeOnly((on) => {
                if (on) {
                  setChosen(new Set(beforeFreeOnly))
                  return false
                }
                beforeFreeOnly = new Set(chosen())
                setChosen(new Set(freeRefs))
                return true
              })
            },
          },
          {
            bind: "a",
            run: () => {
              setChosen((prev) =>
                prev.size === props.models.length
                  ? new Set<string>()
                  : new Set(props.models.map((p) => p.ref)),
              )
            },
          },
          { bind: "return", run: () => props.onDone(chosen()) },
          { bind: "escape", run: () => ui.dialog.clear() },
        ],
      }))

      const visible = () =>
        ordered
          .slice(page() * PICKER_PAGE_ROWS, (page() + 1) * PICKER_PAGE_ROWS)
          .map((row, offset) => ({ row, index: page() * PICKER_PAGE_ROWS + offset }))

      const theme = ctx.theme
      const base = theme?.text?.base
      const muted = theme?.text?.muted
      const accent = theme?.hue?.accent?.[200] ?? base

      return (
        <box flexDirection="column" gap={0}>
          <text fg={base} attributes={TextAttributes.BOLD}>
            {`Models JEV may consider — ${chosen().size}/${props.models.length}`}
          </text>
          <For each={visible()}>
            {({ row, index }: { row: Row; index: number }) => {
              const active = index === cursor()
              const fg = active ? accent : base
              if (row.kind === "provider") {
                const count = row.refs.filter((ref) => chosen().has(ref)).length
                return (
                  <text fg={fg} attributes={TextAttributes.BOLD}>
                    {`▾ ${row.provider.padEnd(refWidth)} ${count}/${row.refs.length}`}
                  </text>
                )
              }
              const mark = chosen().has(row.ref) ? "[x]" : "[ ]"
              return (
                <text fg={fg}>
                  {`  ${mark} ${row.ref.padEnd(refWidth)} ${priceLabel(row.pricePerMTok).padStart(11)}`}
                </text>
              )
            }}
          </For>
          <text fg={muted}>
            {`page ${page() + 1}/${pages()} ←/→ · space toggle · f free-only: ${freeOnly() ? "ON" : "OFF"} · a all/none`}
          </text>
          <text fg={muted}>enter save · esc cancel</text>
        </box>
      )
    }

    return () => {
      unregisterRoute()
    }
  },
})
