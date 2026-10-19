/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { counterfactualGain, readBridge, writeBridge } from "../bridge"
import type { BridgeDecision, BridgeState } from "../bridge"

/**
 * TUI surface for jev-model-picker.
 *
 * - session transcript: a probability bar footer per delegation (src/hook.ts)
 * - right sidebar: ONE row in OpenCode's sidebar design language — status
 *   glyph on the left, bold "JEV" label, muted status, plus a muted "saved"
 *   line. Glyphs follow OMO-Slim: braille spinner while working, ✦ star
 *   after a recent pick, • idle.
 * - session panel (right side): status + the last delegated prompt, full
 *   width, no models and no probabilities
 * - history subscreen: transcript-style blocks for every pick — full prompt,
 *   model, bar — inside a scrollbox; esc returns to the session
 */

const PLUGIN_ID = "jev-model-picker"
const PANEL_NAME = `${PLUGIN_ID}.history`
const SAVINGS_POLL_MS = 2000
const BRIDGE_WRITE_DEBOUNCE_MS = 2000
const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000
const WORKING_WINDOW_MS = 60 * 1000
const HISTORY_BAR_WIDTH = 24
const PICKER_PAGE_ROWS = 11

// Braille activity frames, same set the OMO-Slim sidebar animates.
const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠇", "⠉", "⠏"]
const ACTIVITY_FRAME_MS = 80
const STAR_GLYPH = "✦"
const IDLE_GLYPH = "•"
const RECENT_COLOR = "#60a5fa"

// Same left rail the session transcript uses for message blocks.
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

function bar(fraction: number, width: number): string {
  const value = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  const filled = Math.round(value * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
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

let pluginCtx: Context

function isSelecting(): boolean {
  try {
    return Boolean(pluginCtx?.renderer?.getSelection?.()?.getSelectedText?.())
  } catch {
    return false
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
    const savedByTs = new Map<number, number>()

    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)

    const refresh = () => {
      try {
        const fresh = readBridge()
        if (fresh.rev === bridge.rev) return
        bridge = fresh
        bump()
      } catch {
        // ignore
      }
    }

    /** Merge accumulated state onto the latest file, then write atomically. */
    const commit = (patch?: (state: BridgeState) => void) => {
      try {
        const fresh = readBridge()
        patch?.(fresh)
        for (const decision of fresh.decisions) {
          const saved = savedByTs.get(decision.ts)
          if (saved !== undefined) decision.saved = saved
        }
        writeBridge(fresh)
        bridge = readBridge()
        bump()
      } catch {
        // ignore
      }
    }

    // --------------------------------------------------- savings accounting

    /**
     * Counterfactual savings: the tokens a family burned since the last
     * measurement, priced at the lane's default model, minus what the family
     * actually paid. Free picks cost ~$0 but their avoided cost is real.
     */
    type FamilyUsage = { tokens: number; cost: number }
    const familyUsage = new Map<string, FamilyUsage>()

    const tokensFor = async (rootID: string): Promise<number> => {
      let ids: string[] = []
      try {
        ids = data.session.family(rootID)
      } catch {
        return 0
      }
      await Promise.all(
        ids.map((id) => Promise.resolve(data.session.message.sync(id)).catch(() => undefined)),
      )
      let total = 0
      for (const id of ids) {
        for (const message of data.session.message.list(id) ?? []) {
          const tokens = (message as any)?.tokens
          if (!tokens) continue
          total +=
            Number(tokens.input ?? 0) +
            Number(tokens.output ?? 0) +
            Number(tokens.reasoning ?? 0)
        }
      }
      return total
    }

    const attribute = async () => {
      const latest = new Map<string, BridgeDecision>()
      const now = Date.now()
      for (const decision of bridge.decisions) {
        if (!decision.sessionID) continue
        if (now - decision.ts > ATTRIBUTION_WINDOW_MS) continue
        let root: string
        try {
          root = data.session.root(decision.sessionID)
        } catch {
          continue
        }
        const held = latest.get(root)
        if (!held || decision.ts > held.ts) latest.set(root, decision)
      }
      let changed = false
      for (const [root, decision] of latest) {
        let cost = 0
        try {
          cost = data.session.cost(root) ?? 0
        } catch {
          continue
        }
        const tokens = await tokensFor(root)
        const previous = familyUsage.get(root) ?? { tokens, cost }
        familyUsage.set(root, { tokens, cost })
        const gain = counterfactualGain(
          tokens - previous.tokens,
          decision.defaultPrice ?? 0,
          cost - previous.cost,
        )
        if (gain <= 0) continue
        // Accumulate by timestamp so concurrent server writes never lose it.
        savedByTs.set(decision.ts, (savedByTs.get(decision.ts) ?? 0) + gain)
        changed = true
      }
      return changed
    }

    let lastWrite = 0
    let attributing = false
    const poll = async () => {
      refresh()
      if (attributing) return
      attributing = true
      try {
        const changed = await attribute()
        if (changed && Date.now() - lastWrite > BRIDGE_WRITE_DEBOUNCE_MS) {
          lastWrite = Date.now()
          commit()
        }
      } finally {
        attributing = false
      }
    }

    onMount(() => {
      const timer = setInterval(() => void poll(), SAVINGS_POLL_MS)
      onCleanup(() => clearInterval(timer))
    })

    // ------------------------------------------------------------ glyph logic

    const [now, setNow] = createSignal(Date.now())
    const lastPick = () => bridge.decisions[0]
    const savedOf = (d: BridgeDecision) => savedByTs.get(d.ts) ?? d.saved ?? 0
    const savedTotal = () =>
      bridge.decisions.reduce((sum: number, d: BridgeDecision) => sum + savedOf(d), 0)

    const status = () => {
      if (!bridge.enabled) {
        return { glyph: IDLE_GLYPH, color: undefined, label: "off", working: false }
      }
      const last = lastPick()
      if (!last) return { glyph: IDLE_GLYPH, color: undefined, label: "ready", working: false }
      if (now() - last.ts < WORKING_WINDOW_MS) {
        return {
          glyph: ACTIVITY_FRAMES[Math.floor(now() / ACTIVITY_FRAME_MS) % ACTIVITY_FRAMES.length]!,
          color: ctx.theme?.text?.feedback?.success?.base,
          label: "working",
          working: true,
        }
      }
      return { glyph: STAR_GLYPH, color: RECENT_COLOR, label: "picked", working: false }
    }

    // Animate only while working, like the OMO-Slim sidebar does.
    onMount(() => {
      const timer = setInterval(() => {
        const s = status()
        if (s.working) setNow(Date.now())
      }, ACTIVITY_FRAME_MS)
      onCleanup(() => clearInterval(timer))
    })

    // -------------------------------------------------------------- commands

    const toggleEnabled = () => {
      commit((state) => {
        state.enabled = !state.enabled
      })
      ui.toast.show({
        title: "JEV",
        message: bridge.enabled ? "assistance ON" : "assistance OFF",
        variant: bridge.enabled ? "success" : "warning",
      })
    }

    const openHistory = () => {
      ui.router.navigate({ type: "plugin", id: PLUGIN_ID, name: "history" })
    }

    const openPanel = () => {
      const route = ui.router.current()
      if (route.type !== "session") {
        openHistory()
        return
      }
      const opened = ui.panel.open(PANEL_NAME)
      if (!opened) openHistory()
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
          ui.dialog.set({ size: "medium" })
          ui.dialog.show(() => (
            <ModelPicker
              models={prices}
              selected={allow()}
              onDone={(next) => {
                commit((state) => {
                  state.settings = {
                    ...state.settings,
                    allowlist: next.size === prices.length ? [] : [...next],
                  }
                })
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
          commit((state) => {
            state.settings = {
              ...state.settings,
              backend: {
                baseURL,
                apiKey: apiKey?.trim() || undefined,
                model: model?.trim() || undefined,
              },
            }
          })
          ui.toast.show({ title: "JEV", message: `backend linked: ${baseURL}`, variant: "success" })
        },
      },
      {
        id: `${PLUGIN_ID}.panel`,
        title: "JEV: status panel",
        description: "Side panel: is JEV working, and the last delegated prompt",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-panel" },
        run: openPanel,
      },
      {
        id: `${PLUGIN_ID}.history`,
        title: "JEV: decision history",
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

    /**
     * One row, OpenCode sidebar style: glyph on the left, bold label, muted
     * status to the right; a muted "saved" line under it. Clicking the row
     * opens the status panel.
     */
    ui.slot({
      append: "sidebar.content",
      render: () => {
        void version()
        void now()
        const theme = ctx.theme
        const base = theme?.text?.base
        const muted = theme?.text?.muted
        const s = status()
        const saved = savedTotal()
        const last = lastPick()
        return (
          <box flexDirection="column">
            <box
              flexDirection="row"
              gap={1}
              minWidth={0}
              onMouseUp={() => {
                if (isSelecting()) return
                openPanel()
              }}
            >
              <text flexShrink={0} width={2} style={{ fg: s.color ?? muted }}>
                {s.glyph}
              </text>
              <text fg={base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                <b>JEV</b>
                <span style={{ fg: muted }}>{` ${s.label}`}</span>
                <Show when={last && !s.working}>
                  <span style={{ fg: muted }}>{` · ${clockTime(last!.ts)}`}</span>
                </Show>
              </text>
            </box>
            <Show when={saved > 0}>
              <text fg={muted} wrapMode="none" truncate flexShrink={0}>
                {`saved $${saved.toFixed(4)}`}
              </text>
            </Show>
          </box>
        )
      },
    })

    // ---------------------------------------------------------- history UI

    /**
     * One decision as a transcript-style message block: role + time, the
     * full delegated prompt, the model chosen, and its probability bar.
     */
    function historyEntry(decision: BridgeDecision) {
      const theme = ctx.theme
      const base = theme?.text?.base
      const muted = theme?.text?.muted
      const accent = theme?.hue?.accent?.[200] ?? base
      const saved = savedOf(decision)
      return (
        <box {...SplitBorder} borderColor={accent} paddingLeft={1} flexDirection="column" gap={0}>
          <text fg={base} attributes={TextAttributes.BOLD}>
            {`▸ ${decision.lane || "delegated task"} · ${clockTime(decision.ts)}`}
          </text>
          <text fg={base} wrapMode="word">
            {decision.task}
          </text>
          <text fg={accent} attributes={TextAttributes.BOLD}>
            {`JEV picked ${decision.model}`}
          </text>
          <text fg={accent}>
            {`${bar(decision.probability, HISTORY_BAR_WIDTH)} ${(decision.probability * 100).toFixed(1)}%`}
          </text>
          <Show when={decision.defaultModel}>
            <text fg={muted}>{`default ${decision.defaultModel}`}</text>
          </Show>
          <Show when={saved > 0}>
            <text fg={accent}>{`saved +$${saved.toFixed(4)} on this task`}</text>
          </Show>
          <text fg={muted}>{`${decision.reason || ""}${decision.backend ? ` · ${decision.backend}` : ""}`}</text>
        </box>
      )
    }

    // History subscreen (route page): every pick, full prompts, all bars.
    function HistoryRoute() {
      const theme = ctx.theme
      keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: `${PLUGIN_ID}.history.exit`,
            bind: "escape",
            title: "Back to session",
            run: () => {
              const last = bridge.decisions[0]
              if (last?.sessionID) {
                ui.router.navigate({ type: "session", sessionID: last.sessionID })
                return
              }
              ui.router.navigate({ type: "home" })
            },
          },
        ],
      }))
      return (
        <box flexDirection="column" padding={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme?.text?.base} attributes={TextAttributes.BOLD}>
              JEV decision history
            </text>
            <text fg={theme?.hue?.accent?.[200] ?? theme?.text?.base} attributes={TextAttributes.BOLD}>
              {`saved $${savedTotal().toFixed(4)}`}
            </text>
          </box>
          <text fg={theme?.text?.muted}>
            {`${bridge.decisions.length} picks · esc back to session`}
          </text>
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1}>
              <Show
                when={bridge.decisions.length > 0}
                fallback={<text fg={theme?.text?.muted}>No JEV decisions recorded yet.</text>}
              >
                <For each={bridge.decisions}>{(decision: BridgeDecision) => historyEntry(decision)}</For>
              </Show>
            </box>
          </scrollbox>
        </box>
      )
    }

    const unregisterRoute = ui.router.register({
      name: "history",
      render: () => <HistoryRoute />,
    })

    // ---------------------------------------------------------- session UI

    /**
     * Session panel: status only — is JEV working, did the last pick land,
     * and the full prompt it answered. No models, no probabilities.
     */
    function JevStatusPanel(props: { panel: PanelInput }) {
      const theme = ctx.theme
      const base = theme?.text?.base
      const muted = theme?.text?.muted
      const accent = theme?.hue?.accent?.[200] ?? base
      const s = status()
      keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: `${PLUGIN_ID}.panel.close`,
            bind: "escape",
            title: "Close JEV panel",
            run: () => props.panel.close(),
          },
          {
            id: `${PLUGIN_ID}.panel.history`,
            bind: "h",
            title: "Full JEV history",
            run: openHistory,
          },
        ],
      }))
      return (
        <box flexDirection="column" padding={1} gap={1}>
          <box flexDirection="row" gap={1} minWidth={0}>
            <text flexShrink={0} width={2} style={{ fg: s.color ?? muted }}>
              {s.glyph}
            </text>
            <text fg={base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
              <b>JEV</b>
              <span style={{ fg: muted }}>{` ${s.label} · ${bridge.decisions.length} picks`}</span>
            </text>
          </box>
          <Show when={lastPick()} fallback={<text fg={muted}>no delegated tasks yet</text>}>
            {(pick: () => BridgeDecision) => (
              <>
                <text fg={accent}>{`last pick ✓ ${clockTime(pick().ts)}`}</text>
                <text fg={muted}>last prompt</text>
                <text fg={base} wrapMode="word">
                  {pick().task}
                </text>
              </>
            )}
          </Show>
          <text fg={accent} attributes={TextAttributes.BOLD}>
            {`saved $${savedTotal().toFixed(4)}`}
          </text>
          <text fg={muted}>esc close · h full history</text>
        </box>
      )
    }

    ui.slot({
      append: "session.panel",
      render: (panel: PanelInput) => (
        <Show when={panel.name === PANEL_NAME}>
          <JevStatusPanel panel={panel} />
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
        <box flexDirection="column" padding={1} gap={0}>
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
          <text fg={muted} marginTop={1}>
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
