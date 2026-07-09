import { create } from "zustand";

/** Which case the generation drawer is targeting, if any. */
interface AgentDrawerState {
  caseId: string | null;
  caseTitle: string;
  /** true = update a drifted spec, false = generate a new one. */
  update: boolean;
  open: (target: { caseId: string; caseTitle: string; update: boolean }) => void;
  close: () => void;
}

export const useAgentDrawer = create<AgentDrawerState>((set) => ({
  caseId: null,
  caseTitle: "",
  update: false,
  open: ({ caseId, caseTitle, update }) =>
    set({ caseId, caseTitle, update }),
  close: () => set({ caseId: null }),
}));
