/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { counterfactualGain, readBridge, writeBridge } from "../bridge"
import type { BridgeDecision, BridgeState } from "../bridge"
import type { Substitution } from "../tell"
import {
  formatSubstitution,
  summarizeSubstitutions,
  substitutionFromDecision,
} from "../tell"
import {
  budgetSnapshot,
  DEFAULT_BUDGET_POLICY,
  describeBudget,
  PLAN_IDS,
  resolveBudgetPolicy,
} from "../limits"

/**
 * TUI surface for jev-model-picker.
 *
 * - session transcript: a probability bar footer per delegation (src/hook.ts)
 * - right sidebar: ONE row in OpenCode's sidebar design language — status
 *   glyph on the left, bold "JEV" label, then the last delegated prompt of
 *   THIS session as a one-liner; a muted "saved" line under it.
 *   Glyphs follow OMO-Slim: braille spinner while working, ✦ star after a
 *   recent pick, • idle.
 * - session panel (right side): status + the last delegated prompt of this
 *   session, full width — no models, no probabilities
 *
 * Everything shown is scoped to the current session (its root family), and
 * the cost estimate is per session.
 */

const PLUGIN_ID = "jev-model-picker"
const PANEL_NAME = `${PLUGIN_ID}.status`
const SAVINGS_POLL_MS = 2000
const BRIDGE_WRITE_DEBOUNCE_MS = 2000
const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000
const WORKING_WINDOW_MS = 60 * 1000
const PICKER_PAGE_ROWS = 11

// Braille activity frames, same set the OMO-Slim sidebar animates.
const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠇", "⠉", "⠏"]
const ACTIVITY_FRAME_MS = 80
const STAR_GLYPH = "✦"
const IDLE_GLYPH = "•"
const RECENT_COLOR = "#60a5fa"

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/** One-line, whitespace-collapsed prompt for the sidebar row. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
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

    // Track recent substitutions from bridge decisions
    const [recentSub, setRecentSub] = createSignal<Substitution | null>(null)
    const [subHistory, setSubHistory] = createSignal<Substitution[]>([])

    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)

    const refresh = () => {
      try {
        const fresh = readBridge()
        if (fresh.rev === bridge.rev) return
        bridge = fresh
        bump()
        // Compute substitutions from the new bridge decisions.
        const decisions: BridgeDecision[] = fresh.decisions
        // substitutionFromDecision reads the lane and the pin off the decision
        // itself — passing a settings value here would put a model ref in the
        // lane field.
        const history = decisions
          .map((d) => substitutionFromDecision(d))
          .filter((s) => s.source !== "preset-kept") // keep only actual substitutions
        setSubHistory(history)
        setRecentSub(history.length > 0 ? history[0] : null)
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
     * Accounting is global (per decision, by timestamp); what is DISPLAYED is
     * scoped to the current session further below.
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
          total += Number(tokens.input ?? 0) + Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0)
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

    // ------------------------------------------------------- session scoping

    /**
     * Everything displayed is scoped to a session's root family, so the
     * history and the cost estimate are per session — switching sessions
     * shows that session's own picks and its own savings.
     */
    const sessionRoot = (sessionID: string | undefined): string | undefined => {
      if (!sessionID) return undefined
      try {
        return data.session.root(sessionID)
      } catch {
        return sessionID
      }
    }

    const decisionsFor = (sessionID: string | undefined): BridgeDecision[] => {
      if (!sessionID) return []
      const root = sessionRoot(sessionID)
      return bridge.decisions
        .filter((d) => d.sessionID && sessionRoot(d.sessionID) === root)
        .sort((a, b) => b.ts - a.ts)
    }

    const savedOf = (d: BridgeDecision) => savedByTs.get(d.ts) ?? d.saved ?? 0
    const savedFor = (sessionID: string | undefined): number =>
      decisionsFor(sessionID).reduce((sum, d) => sum + savedOf(d), 0)

    // ------------------------------------------------------------ glyph logic

    const [now, setNow] = createSignal(Date.now())
    const statusFor = (sessionID: string | undefined) => {
      if (!bridge.enabled) {
        return { glyph: IDLE_GLYPH, color: undefined, label: "off", working: false }
      }
      const last = decisionsFor(sessionID)[0]
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
        const route = ui.router.current()
        const sid = route.type === "session" ? route.sessionID : undefined
        if (sid && statusFor(sid).working) setNow(Date.now())
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

    const openPanel = () => {
      const route = ui.router.current()
      if (route.type !== "session") return false
      return ui.panel.open(PANEL_NAME)
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
        id: `${PLUGIN_ID}.plan`,
        title: "JEV: subscription plan & budget floor",
        description: "Go, Go Plus or Go Teams; skip models with below this much left",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-plan" },
        run: async () => {
          const current = readBridge().settings?.budget as
            | Record<string, unknown>
            | undefined
          const plan = await ui.dialog.prompt({
            title: "Subscription plan",
            description: "go · go-plus · go-teams — sets each model's monthly allowance",
            placeholder: String(current?.plan ?? "go"),
          })
          if (plan === undefined) return
          const floor = await ui.dialog.prompt({
            title: "Floor (USD)",
            description: "Skip models with less than this left — empty keeps the default",
            placeholder: String(current?.floorUsd ?? "0.5"),
          })
          const planRaw = String(plan).trim()
          const planValue: (typeof PLAN_IDS)[number] = (
            PLAN_IDS as readonly string[]
          ).includes(planRaw)
            ? (planRaw as (typeof PLAN_IDS)[number])
            : "go"
          const settings: Record<string, unknown> = {
            ...readBridge().settings,
            budget: {
              ...current,
              plan: planValue,
              floorUsd: floor?.trim() ? Number(floor) : current?.floorUsd,
              floorPct: current?.floorPct,
              windowAware: current?.windowAware,
              capacityAware: current?.capacityAware,
              minTasks: current?.minTasks,
              enabled: current?.enabled,
            },
          }
          commit((state) => {
            state.settings = settings
          })
          // Build toast message with optional substitution tell
          const sub = recentSub()
          const subInfo = sub
            ? ` · substituted ${sub.from.slice(0, 15)} → ${sub.to.slice(0, 15)}`
            : ""
          ui.toast.show({
            title: "JEV",
            message: `budget: plan ${settings.budget ? (settings.budget as any).plan : "?"} · floor $${(settings.budget as any).floorUsd ?? "default"}${subInfo}`,
            variant: "success",
          })
        },
      },
      {
        id: `${PLUGIN_ID}.sub`,
        title: "JEV: substitution history",
        description: "List recent model substitutions with reasons",
        group: "JEV",
        palette: true as const,
        slash: { name: "jev-sub" },
        run: async () => {
          const history = subHistory()
          if (history.length === 0) {
            ui.toast.show({ title: "JEV", message: "No substitutions recorded yet", variant: "info" })
            return
          }
          const summary = summarizeSubstitutions(history)
          ui.toast.show({ title: "JEV substitutions", message: summary, variant: "success" })
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
    ]

    // mode "global" keeps commands reachable while the palette pushes "modal".
    keymap.layer(() => ({
      mode: "global",
      commands: commands(),
    }))

    // -------------------------------------------------------------- sidebar
    // Live plan budget: the tightest bucket among the models this session has
    // picked, so the row can say "gemini-4-argon $0.02/$30 left" just before
    // the picker runs dry. Reads the same bundled snapshot the server uses
    // (~120ms on a 400MB DB), refreshed at savings cadence ×5 and cached
    // between refreshes so the line never flickers away.
    const [budgetLine, setBudgetLine] = createSignal<string | undefined>(undefined)
    let budgetAt = 0
    async function refreshBudgetLine(sessionID: string): Promise<void> {
      try {
        const decisions = decisionsFor(sessionID)
        if (decisions.length === 0) {
          setBudgetLine(undefined)
          return
        }
        const policy = resolveBudgetPolicy(
          DEFAULT_BUDGET_POLICY,
          readBridge().settings?.budget,
        )
        if (!policy.enabled) return
        const used = new Set(
          decisions.map((d) => d.model).filter((m): m is string => !!m),
        )
        const snapshot = await budgetSnapshot({ plan: policy.plan })
        const rows = Object.values(snapshot.byRef).filter((info) => used.has(info.ref))
        if (rows.length === 0) return
        const worst = rows.sort((a, b) => a.remainingPct - b.remainingPct)[0]
        setBudgetLine(describeBudget(worst))
      } catch {
        // a budget read failure must never disturb the sidebar
      }
    }

    /**
     * One row, OpenCode sidebar style: glyph on the left, bold label, and the
     * last delegated prompt of THIS session as a one-liner; a muted per
     * session "saved" line under it. Clicking the row opens the status panel.
     */
    ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        void version()
        void now()
        const theme = ctx.theme
        const base = theme?.text?.base
        const muted = theme?.text?.muted
        const s = statusFor(sessionID)
        const saved = savedFor(sessionID)
        const picks = decisionsFor(sessionID)
        const last = picks[0]
        const prompt = last?.task ? oneLine(last.task) : ""
        if (picks.length > 0 && Date.now() - budgetAt > SAVINGS_POLL_MS * 5) {
          budgetAt = Date.now()
          void refreshBudgetLine(sessionID)
        }
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
                <span style={{ fg: muted }}>
                  {` ${s.label} · ${picks.length} picks${
                    prompt ? ` · ${prompt}` : last ? ` · ${clockTime(last.ts)}` : ""
                  }`}
                </span>
              </text>
            </box>
            {/* SUBSTITUTION TELL — most recent from → to */}
            <Show when={recentSub() !== null}>
              <text fg={muted} wrapMode="none" truncate flexShrink={0}>
                {`· ${recentSub()!.from} → ${recentSub()!.to}`}
              </text>
            </Show>
            <Show when={saved > 0}>
              <text fg={muted} wrapMode="none" truncate flexShrink={0}>
                {`saved $${saved.toFixed(4)}`}
              </text>
            </Show>
            <Show when={budgetLine()}>
              <text fg={muted} wrapMode="none" truncate flexShrink={0}>
                {budgetLine()}
              </text>
            </Show>
          </box>
        )
      },
    })

    /**
     * Session panel: status only — is JEV working, did the last pick land,
     * and the full prompt it answered (this session). No models, no bars.
     */
    function JevStatusPanel(props: { panel: PanelInput }) {
      const theme = ctx.theme
      const base = theme?.text?.base
      const muted = theme?.text?.muted
      const accent = theme?.hue?.accent?.[200] ?? base
      const sid = props.panel.sessionID
      const s = statusFor(sid)
      const picks = decisionsFor(sid)
      const last = picks[0]
      if (picks.length > 0 && Date.now() - budgetAt > SAVINGS_POLL_MS * 5) {
        budgetAt = Date.now()
        void refreshBudgetLine(sid)
      }
      keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: `${PLUGIN_ID}.panel.close`,
            bind: "escape",
            title: "Close JEV panel",
            run: () => props.panel.close(),
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
              <span style={{ fg: muted }}>{` ${s.label} · ${picks.length} picks this session`}</span>
            </text>
          </box>
          <Show when={last} fallback={<text fg={muted}>no delegated tasks yet</text>}>
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
            {`saved $${savedFor(sid).toFixed(4)}`}
          </text>
          <Show when={budgetLine()}>
            <text fg={muted} wrapMode="none" truncate>
              {budgetLine()}
            </text>
          </Show>
          <text fg={muted}>esc close · probability bars stay in the transcript</text>
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

    return () => {}
  },
})
