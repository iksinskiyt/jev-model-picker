/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createComponent, For, Show } from "solid-js"

/**
 * TUI surface for jev-model-picker.
 *
 * Renders the "JEV engaged" state in the session panel, exposes commands to
 * toggle assistance, choose the candidate models, and link a decision backend
 * (hosted keyless System One, keyed gateway, or a local openJEV endpoint).
 */

type Decision = {
  ts: number
  model: string
  probability: number
  margin: number
  reason: string
  backend: string
  lane: string
  costDelta: number
}

type State = {
  enabled: boolean
  decisions: Decision[]
}

const MAX_DECISIONS = 200

function bar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(clamped * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export default Plugin.define({
  id: "jev-model-picker-tui",
  async setup(ctx: Context) {
    const { ui, storage, keymap, data } = ctx

    const [state, mutate] = storage.store("jev-model-picker", {
      initial: { enabled: true, decisions: [] } as State,
    })

    const push = (decision: Decision) => {
      mutate((draft) => {
        draft.decisions.unshift(decision)
        if (draft.decisions.length > MAX_DECISIONS) draft.decisions.length = MAX_DECISIONS
      })
    }

    keymap.layer(() => ({
      commands: [
        {
          id: "jev-model-picker.toggle",
          title: "JEV: toggle assistance",
          group: "jev-model-picker",
          palette: true,
          run: () => {
            mutate((draft) => {
              draft.enabled = !draft.enabled
            })
            ui.toast.show({
              message: state.enabled ? "JEV assistance on" : "JEV assistance off",
              variant: state.enabled ? "success" : "warning",
            })
          },
        },
        {
          id: "jev-model-picker.models",
          title: "JEV: choose considered models",
          group: "jev-model-picker",
          palette: true,
          run: async () => {
            const list = (await data.location.model.list()) ?? []
            const options = list.map((m: any) => {
              const ref = m.id ?? `${m.providerID}/${m.modelID}`
              return { title: ref, value: ref }
            })
            if (options.length === 0) {
              ui.toast.show({ message: "No models available", variant: "warning" })
              return
            }
            const picked = await ui.dialog.select({
              title: "Models JEV may consider",
              placeholder: "Search models",
              options,
            })
            if (!picked) return
            mutate((draft) => {
              ;(draft as any).candidateOverride = picked
            })
            ui.toast.show({ message: `Candidate set: ${picked}`, variant: "success" })
          },
        },
        {
          id: "jev-model-picker.link",
          title: "JEV: link decision backend",
          group: "jev-model-picker",
          palette: true,
          run: async () => {
            const url = await ui.dialog.prompt({
              title: "Link JEV backend",
              description: "Base URL for a hosted or local (openJEV) System One endpoint",
              placeholder: "https://opencode.ai/inference/systemone/v1",
            })
            if (!url) return
            const key = await ui.dialog.prompt({
              title: "API key (optional)",
              description: "Leave empty for keyless backends",
            })
            mutate((draft) => {
              ;(draft as any).backend = { baseURL: url, apiKey: key || undefined }
            })
            ui.toast.show({ message: `JEV backend linked: ${url}`, variant: "success" })
          },
        },
        {
          id: "jev-model-picker.history",
          title: "JEV: decision history",
          group: "jev-model-picker",
          palette: true,
          run: () => {
            ui.router.navigate({ type: "plugin", id: "jev-model-picker", name: "history" })
          },
        },
      ],
    }))

    ui.slot({
      append: "session.panel",
      render: (input) => {
        const s = state
        const last = s.decisions[0]
        const saved = s.decisions.reduce((sum: number, d: Decision) => sum + (d.costDelta || 0), 0)
        return (
          <div key={`jev-panel-${input.sessionID}`}>
            <div>JEV {s.enabled ? "ON" : "OFF"}</div>
            {last ? (
              <div>
                <div>picked {last.model}</div>
                <div>{bar(last.probability)} {(last.probability * 100).toFixed(0)}%</div>
              </div>
            ) : (
              <div>no decisions yet</div>
            )}
            {saved !== 0 ? <div>saved ${saved.toFixed(4)}</div> : null}
          </div>
        )
      },
    })

    ui.router.register({
      name: "jev-model-picker",
      render: () => {
        const s = state
        return (
          <div key="jev-history">
            {s.decisions.length === 0 ? (
              <div>No JEV decisions recorded yet.</div>
            ) : (
              <For each={s.decisions}>
                {(d: Decision) => (
                  <div>
                    {bar(d.probability)} {(d.probability * 100).toFixed(0)}% {d.model} {d.reason}
                  </div>
                )}
              </For>
            )}
          </div>
        )
      },
    })

    return () => {}
  },
})
