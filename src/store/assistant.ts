import { create } from "zustand";

export interface AssistantMsg {
  /** For an assistant turn this equals the turn id it was streamed under. */
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  error: boolean;
  /** Tool/log activity lines shown under a streaming assistant turn. */
  activity: string[];
}

interface AssistantState {
  open: boolean;
  /** Selected agent id ("claude-code" | "codex"). */
  agentId: string;
  /** Claude Code session id for conversation continuity across turns. */
  sessionId: string | null;
  messages: AssistantMsg[];
  busy: boolean;
  /** The turn currently streaming, or null. Stale events are ignored. */
  currentTurnId: string | null;

  toggle: () => void;
  setOpen: (open: boolean) => void;
  setAgent: (id: string) => void;
  /** Start a fresh conversation (drops session + transcript). */
  reset: () => void;

  beginTurn: (turnId: string, userText: string) => void;
  appendText: (turnId: string, text: string) => void;
  appendActivity: (turnId: string, line: string) => void;
  finishTurn: (
    turnId: string,
    reply: string,
    sessionId: string | null,
    error: string | null,
  ) => void;
}

export const useAssistant = create<AssistantState>((set, get) => ({
  open: false,
  agentId: "claude-code",
  sessionId: null,
  messages: [],
  busy: false,
  currentTurnId: null,

  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  setAgent: (agentId) => set({ agentId }),
  reset: () =>
    set({ messages: [], sessionId: null, busy: false, currentTurnId: null }),

  beginTurn: (turnId, userText) =>
    set((s) => ({
      busy: true,
      currentTurnId: turnId,
      messages: [
        ...s.messages,
        {
          id: `${turnId}:user`,
          role: "user",
          content: userText,
          streaming: false,
          error: false,
          activity: [],
        },
        {
          id: turnId,
          role: "assistant",
          content: "",
          streaming: true,
          error: false,
          activity: [],
        },
      ],
    })),

  appendText: (turnId, text) => {
    if (get().currentTurnId !== turnId) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === turnId
          ? { ...m, content: m.content ? `${m.content}\n${text}` : text }
          : m,
      ),
    }));
  },

  appendActivity: (turnId, line) => {
    if (get().currentTurnId !== turnId) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === turnId ? { ...m, activity: [...m.activity, line] } : m,
      ),
    }));
  },

  finishTurn: (turnId, reply, sessionId, error) => {
    if (get().currentTurnId !== turnId) return;
    set((s) => ({
      busy: false,
      currentTurnId: null,
      sessionId: sessionId ?? s.sessionId,
      messages: s.messages.map((m) =>
        m.id === turnId
          ? {
              ...m,
              streaming: false,
              error: !!error,
              content: error
                ? error
                : reply.trim()
                  ? reply
                  : m.content || "(no output)",
            }
          : m,
      ),
    }));
  },
}));
