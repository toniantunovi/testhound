import { create } from "zustand";
import type { ProjectInfo } from "@/lib/types";

export type View =
  | "dashboard"
  | "cases"
  | "case-editor"
  | "runs"
  | "new-run"
  | "run-view"
  | "automation"
  | "merge"
  | "reports"
  | "settings";

interface SessionState {
  project: ProjectInfo | null;
  view: View;
  /** Selected suite id in the Cases tree, or "all". */
  selectedSuite: string;
  selectedSection: string | null;
  /** Case currently open in the editor. */
  openCaseId: string | null;
  /** Run currently open in the execution view. */
  openRunId: string | null;
  activityOpen: boolean;

  setProject: (p: ProjectInfo | null) => void;
  navigate: (view: View) => void;
  selectSuite: (suite: string, section?: string | null) => void;
  openCase: (id: string) => void;
  openRun: (id: string) => void;
  newRun: () => void;
  toggleActivity: () => void;
  setActivity: (open: boolean) => void;
}

export const useSession = create<SessionState>((set) => ({
  project: null,
  view: "dashboard",
  selectedSuite: "all",
  selectedSection: null,
  openCaseId: null,
  openRunId: null,
  activityOpen: false,

  setProject: (project) => set({ project }),
  navigate: (view) => set({ view }),
  selectSuite: (selectedSuite, selectedSection = null) =>
    set({ selectedSuite, selectedSection, view: "cases" }),
  openCase: (openCaseId) => set({ openCaseId, view: "case-editor" }),
  openRun: (openRunId) => set({ openRunId, view: "run-view" }),
  newRun: () => set({ view: "new-run" }),
  toggleActivity: () => set((s) => ({ activityOpen: !s.activityOpen })),
  setActivity: (activityOpen) => set({ activityOpen }),
}));
