import { create } from "zustand";
import type { ProjectInfo } from "@/lib/types";

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

export const useSession = create<SessionState>((set) => ({
  project: null,
  view: "dashboard",
  selectedSuite: "all",
  selectedSection: null,
  openCaseId: null,
  openRunId: null,
  editRunId: null,
  automationFocus: null,
  activityOpen: false,
  paletteOpen: false,

  setProject: (project) => set({ project }),
  navigate: (view) => set({ view }),
  selectSuite: (selectedSuite, selectedSection = null) =>
    set({ selectedSuite, selectedSection, view: "cases" }),
  openCase: (openCaseId) => set({ openCaseId, view: "case-editor" }),
  openCaseHistory: (openCaseId) => set({ openCaseId, view: "case-history" }),
  openRun: (openRunId) => set({ openRunId, view: "run-view" }),
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
