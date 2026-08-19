import { create } from "zustand";
import { track } from "@/lib/telemetry";

/** Where the assistant terminal sits. It is a panel beside a screen, not a screen. */
export type Dock = "right" | "bottom";

/** Wide enough for the agent's boxes, tall enough for a turn to be readable. */
const MIN = { width: 420, height: 200 };

const LAYOUT_KEY = "testhound.assistant.layout";

interface Layout {
  open: boolean;
  dock: Dock;
  /** Panel width when docked right, in px. */
  width: number;
  /** Panel height when docked bottom, in px. */
  height: number;
  /** The agent CLI the terminal runs. Changing it restarts the session. */
  agentId: string;
}

/** Geometry and agent choice only: never anything the agent said. */
function loadLayout(): Layout {
  // 640px is about 76 columns at the panel's font size, which is where an agent's
  // boxes stop having to wrap.
  const fallback: Layout = {
    open: false,
    dock: "right",
    width: 640,
    height: 360,
    agentId: "claude-code",
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

function saveLayout(l: Layout): Layout {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  return l;
}

interface AssistantState extends Layout {
  /** True while the pty is producing output, i.e. the agent is working. A terminal
   *  has no turn-finished event; this is driven by output going quiet. */
  busy: boolean;
  /** Text waiting to be typed onto the agent's prompt; the user reads it and sends. */
  draft: string | null;
  /** Text queued to be typed and submitted with no confirmation. Used by background
   *  flows like Playwright initialization. */
  pendingSend: string | null;
  /** A spec generation/update awaiting its spec, so the panel can link it in code
   *  once the agent has written it (the agent never edits the case itself). */
  pendingGeneration: { caseId: string; update: boolean } | null;

  toggle: () => void;
  setOpen: (open: boolean) => void;
  setAgent: (id: string) => void;
  setDock: (d: Dock) => void;
  /** Drag result, in px along the docked edge. Clamped to something usable. */
  setSize: (px: number) => void;
  setBusy: (busy: boolean) => void;
  /** Open the panel with `text` typed onto the prompt, awaiting the user's Enter. */
  prefill: (text: string) => void;
  clearDraft: () => void;
  /** Open the panel and submit `text` straight away (no user confirmation). */
  queueSend: (text: string) => void;
  clearPendingSend: () => void;
  /** Stage a generation prompt and remember which case it targets, so the panel can
   *  link the resulting spec once it lands on disk. */
  startGeneration: (caseId: string, update: boolean, prompt: string) => void;
  clearGeneration: () => void;
}

export const useAssistant = create<AssistantState>((set, get) => ({
  ...loadLayout(),
  busy: false,
  draft: null,
  pendingSend: null,
  pendingGeneration: null,

  toggle: () => set((s) => saveLayout({ ...layoutOf(s), open: !s.open })),
  setOpen: (open) => set((s) => saveLayout({ ...layoutOf(s), open })),
  setAgent: (agentId) => set((s) => saveLayout({ ...layoutOf(s), agentId })),
  setDock: (dock) => set((s) => saveLayout({ ...layoutOf(s), dock, open: true })),
  setSize: (px) =>
    set((s) => {
      // Leave the screen itself usable: the panel never takes the whole window.
      // Sideways that means allowing for the sidebar too, which is not the screen.
      const room =
        s.dock === "right" ? window.innerWidth - 620 : window.innerHeight - 260;
      const key = s.dock === "right" ? "width" : "height";
      const clamped = Math.max(MIN[key], Math.min(px, Math.max(MIN[key], room)));
      return saveLayout({ ...layoutOf(s), [key]: clamped });
    }),
  setBusy: (busy) => set({ busy }),

  prefill: (draft) => set((s) => ({ ...saveLayout({ ...layoutOf(s), open: true }), draft })),
  clearDraft: () => set({ draft: null }),
  queueSend: (pendingSend) =>
    set((s) => ({ ...saveLayout({ ...layoutOf(s), open: true }), pendingSend })),
  clearPendingSend: () => set({ pendingSend: null }),
  startGeneration: (caseId, update, prompt) => {
    // The user kicked off a spec generation/update: the differentiator-adoption
    // signal. Acceptance is tracked separately once a spec lands and links.
    void track("spec_generated", { agent: get().agentId, update });
    set((s) => ({
      ...saveLayout({ ...layoutOf(s), open: true }),
      pendingGeneration: { caseId, update },
      draft: prompt,
    }));
  },
  clearGeneration: () => set({ pendingGeneration: null }),
}));

/** The persisted slice of the state, so an action can save it without listing keys. */
function layoutOf(s: Layout): Layout {
  const { open, dock, width, height, agentId } = s;
  return { open, dock, width, height, agentId };
}
