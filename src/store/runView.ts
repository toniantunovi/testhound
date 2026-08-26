import { create } from "zustand";
import type { ResultStatus } from "@/lib/types";

/** What the run view is currently showing: its status filter, its search, and
 *  the case open in the slide-over. It lives outside the screen so stepping
 *  into a case editor and coming back leaves the run exactly as it was; it is
 *  reset when a different run is opened (see `openRun` in the session store). */
interface RunViewState {
  /** Statuses the case list is narrowed to; empty means show everything. */
  statuses: Set<ResultStatus>;
  /** The search box over the run's cases. */
  query: string;
  /** Case open in the read-and-record slide-over, if any. */
  panelCaseId: string | null;

  toggleStatus: (status: ResultStatus) => void;
  clearStatuses: () => void;
  setQuery: (query: string) => void;
  setPanelCase: (caseId: string | null) => void;
  reset: () => void;
}

export const useRunView = create<RunViewState>((set) => ({
  statuses: new Set(),
  query: "",
  panelCaseId: null,

  toggleStatus: (status) =>
    set((s) => {
      const statuses = new Set(s.statuses);
      if (!statuses.delete(status)) statuses.add(status);
      return { statuses };
    }),
  clearStatuses: () => set({ statuses: new Set() }),
  setQuery: (query) => set({ query }),
  setPanelCase: (panelCaseId) => set({ panelCaseId }),
  reset: () => set({ statuses: new Set(), query: "", panelCaseId: null }),
}));
