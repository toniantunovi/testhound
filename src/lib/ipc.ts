// Typed wrappers over Tauri IPC commands. One function per Rust #[tauri::command].
import { invoke } from "@tauri-apps/api/core";
import type {
  CaseSummary,
  Configuration,
  Dashboard,
  GitStatus,
  IncludeMode,
  Milestone,
  ProjectInfo,
  RepoInfo,
  ResultStatus,
  Run,
  RunDetail,
  RunSummary,
  SuiteTree,
  TestCase,
} from "./types";

export interface CreateRunInput {
  name: string;
  milestone?: string | null;
  configuration: string[];
  description?: string | null;
  assignee?: string | null;
  mode: IncludeMode;
  query?: string | null;
  suites: string[];
  cases: string[];
}

export const api = {
  inspectRepo: (path: string) => invoke<RepoInfo>("inspect_repo", { path }),
  cloneRepo: (url: string, dest: string) =>
    invoke<RepoInfo>("clone_repo", { url, dest }),
  scaffoldProject: (path: string, name: string, seed: boolean) =>
    invoke<ProjectInfo>("scaffold_project", { path, name, seed }),
  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
  currentProject: () => invoke<ProjectInfo | null>("current_project"),

  listSuites: () => invoke<SuiteTree[]>("list_suites"),
  listCases: () => invoke<CaseSummary[]>("list_cases"),
  getCase: (id: string) => invoke<TestCase>("get_case", { id }),
  saveCase: (testCase: TestCase) => invoke<TestCase>("save_case", { case: testCase }),
  createCase: (suite: string, title: string) =>
    invoke<TestCase>("create_case", { suite, title }),

  gitStatus: () => invoke<GitStatus>("git_status"),
  listBranches: () => invoke<string[]>("list_branches"),
  switchBranch: (name: string) => invoke<GitStatus>("switch_branch", { name }),

  dashboard: () => invoke<Dashboard>("dashboard"),

  listRuns: () => invoke<RunSummary[]>("list_runs"),
  getRun: (id: string) => invoke<RunDetail>("get_run", { id }),
  previewRun: (
    mode: IncludeMode,
    query: string | null,
    suites: string[],
    cases: string[],
  ) => invoke<CaseSummary[]>("preview_run", { mode, query, suites, cases }),
  createRun: (input: CreateRunInput) => invoke<Run>("create_run", { ...input }),
  setResult: (
    runId: string,
    caseId: string,
    status: ResultStatus,
    comment: string | null,
    executedBy: string | null,
  ) =>
    invoke<unknown>("set_result", {
      runId,
      caseId,
      status,
      comment,
      executedBy,
    }),
  setRunState: (runId: string, runState: Run["state"]) =>
    invoke<Run>("set_run_state", { runId, runState }),

  listMilestones: () => invoke<Milestone[]>("list_milestones"),
  listConfigurations: () => invoke<Configuration[]>("list_configurations"),
};

/** Normalize an IPC error (a plain string from the Rust side) to a message. */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
