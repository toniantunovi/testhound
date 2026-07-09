import { create } from "zustand";

/** The live Playwright run console: streamed log lines + which run is active. */
interface ActivityState {
  lines: string[];
  /** The run currently executing, or null when idle. */
  runningRunId: string | null;
  /** A short summary of the last finished run, for the collapsed bar. */
  lastSummary: string | null;

  start: (runId: string) => void;
  push: (line: string) => void;
  finish: (summary: string | null) => void;
  clear: () => void;
}

const MAX_LINES = 500;

export const useActivity = create<ActivityState>((set) => ({
  lines: [],
  runningRunId: null,
  lastSummary: null,

  start: (runId) => set({ runningRunId: runId, lines: [] }),
  push: (line) =>
    set((s) => ({
      lines: [...s.lines, line].slice(-MAX_LINES),
    })),
  finish: (summary) =>
    set({ runningRunId: null, lastSummary: summary }),
  clear: () => set({ lines: [], lastSummary: null }),
}));
