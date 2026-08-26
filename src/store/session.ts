import { create } from "zustand";
import type { ProjectInfo } from "@/lib/types";
import { useRunView } from "@/store/runView";

export type View =
  | "dashboard"
  | "cases"
  | "case-editor"
  | "case-history"
  | "runs"
  | "new-run"
  | "run-view"
  | "automation"
  | "changes"
  | "merge"
  | "reports"
  | "settings";

interface SessionState {
  project: ProjectInfo | null;
  view: View;
  /** Selected suite id in the Cases tree, or "all". */
  selectedSuite: string;
  selectedSection: string | null;
  /** Case currently open in the editor / history view. */
  openCaseId: string | null;
  /** Where the case editor was entered from, so closing it goes back there
   *  (a run, Automation, Reports) instead of always to the case list. */
  caseReturn: View | null;
  /** Run currently open in the execution view. */
  openRunId: string | null;
  /** Run the builder is editing, or null when it is building a new one. */
  editRunId: string | null;
  /** Case whose row the Automation view should scroll to and highlight. */
  automationFocus: string | null;
  activityOpen: boolean;
  /** Command palette (⌘K) overlay. */
  paletteOpen: boolean;

  setProject: (p: ProjectInfo | null) => void;
  navigate: (view: View) => void;
  selectSuite: (suite: string, section?: string | null) => void;
  openCase: (id: string) => void;
  openCaseHistory: (id: string) => void;
  /** Leave the case editor for wherever it was opened from. */
  closeCase: () => void;
  openRun: (id: string) => void;
  openAutomation: (caseId: string) => void;
  clearAutomationFocus: () => void;
  newRun: () => void;
  editRun: (id: string) => void;
  toggleActivity: () => void;
  setActivity: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  togglePalette: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  project: null,
  view: "dashboard",
  selectedSuite: "all",
  selectedSection: null,
  openCaseId: null,
  caseReturn: null,
  openRunId: null,
  editRunId: null,
  automationFocus: null,
  activityOpen: false,
  paletteOpen: false,

  setProject: (project) => set({ project }),
  // Navigating by hand (sidebar, palette, a link) drops the editor's return
  // trail: the last screen the user chose is the one to come back to.
  navigate: (view) => set({ view, caseReturn: null }),
  selectSuite: (selectedSuite, selectedSection = null) =>
    set({ selectedSuite, selectedSection, view: "cases" }),
  openCase: (openCaseId) =>
    set((s) => ({ openCaseId, view: "case-editor", caseReturn: origin(s) })),
  openCaseHistory: (openCaseId) =>
    set((s) => ({ openCaseId, view: "case-history", caseReturn: origin(s) })),
  closeCase: () =>
    set((s) => ({ view: s.caseReturn ?? "cases", caseReturn: null })),
  openRun: (openRunId) => {
    // A run's filter and open case belong to that run: opening a different one
    // starts clean, while coming back from a case editor keeps what was set.
    if (get().openRunId !== openRunId) useRunView.getState().reset();
    set({ openRunId, view: "run-view", caseReturn: null });
  },
  openAutomation: (automationFocus) =>
    set({ automationFocus, view: "automation" }),
  clearAutomationFocus: () => set({ automationFocus: null }),
  newRun: () => set({ editRunId: null, view: "new-run" }),
  editRun: (editRunId) => set({ editRunId, view: "new-run" }),
  toggleActivity: () => set((s) => ({ activityOpen: !s.activityOpen })),
  setActivity: (activityOpen) => set({ activityOpen }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
}));

/** The screen a newly opened case should return to. Hopping between the editor
 *  and a case's history keeps the original origin, so the back arrow still
 *  leads out of both. */
function origin(s: SessionState): View | null {
  return s.view === "case-editor" || s.view === "case-history"
    ? s.caseReturn
    : s.view;
}
