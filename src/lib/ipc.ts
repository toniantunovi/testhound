// Typed wrappers over Tauri IPC commands. One function per Rust #[tauri::command].
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentAvailability,
  AgentFinishedEvent,
  AgentLogEvent,
  AgentStartedEvent,
  BlameLine,
  CaseCommitDiff,
  CaseSummary,
  CommitInfo,
  Configuration,
  Conflicts,
  Coverage,
  Dashboard,
  FileDiff,
  GitStatus,
  IdCollision,
  IncludeMode,
  LfsStatus,
  Milestone,
  PlaywrightInfo,
  ProjectInfo,
  RepoContext,
  RepoInfo,
  ResultStatus,
  Run,
  RunDetail,
  RunFinishedEvent,
  RunLogEvent,
  RunProgressEvent,
  RunStartedEvent,
  RunSummary,
  Side,
  SuiteTree,
  TestCase,
  UpdateInfo,
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

  playwrightInfo: () => invoke<PlaywrightInfo>("playwright_info"),
  runPlaywright: (runId: string) => invoke<void>("run_playwright", { runId }),
  openTrace: (path: string) => invoke<void>("open_trace", { path }),

  // AI automation (M4)
  listAgents: () => invoke<AgentAvailability[]>("list_agents"),
  coverage: () => invoke<Coverage>("coverage"),
  automationContext: (id: string) =>
    invoke<RepoContext>("automation_context", { id }),
  fileDiff: (path: string) => invoke<FileDiff>("file_diff", { path }),
  generateSpec: (caseId: string, agentId: string, update: boolean) =>
    invoke<void>("generate_spec", { caseId, agentId, update }),
  acceptGeneration: (caseId: string, specs: string[], generator: string) =>
    invoke<TestCase>("accept_generation", { caseId, specs, generator }),
  triageFailure: (runId: string, caseId: string, agentId: string) =>
    invoke<void>("triage_failure", { runId, caseId, agentId }),

  // Collaboration: conflicts, semantic merge, LFS, updates (M5)
  listConflicts: () => invoke<Conflicts>("list_conflicts"),
  resolveCaseConflict: (path: string, picks: Record<string, Side>) =>
    invoke<TestCase>("resolve_case_conflict", { path, picks }),
  resolveCaseKeep: (path: string, keep: Side) =>
    invoke<TestCase>("resolve_case_keep", { path, keep }),
  resolveCaseDelete: (path: string) =>
    invoke<void>("resolve_case_delete", { path }),
  idCollisions: () => invoke<IdCollision[]>("id_collisions"),
  renumberCase: (path: string) => invoke<string>("renumber_case", { path }),

  // Changes, commit & sync (M6)
  commitChanges: (message: string, files: string[]) =>
    invoke<GitStatus>("commit_changes", { message, files }),
  pushChanges: () => invoke<string>("push_changes"),
  syncRepo: () => invoke<string>("sync_repo"),

  // Case history & diff (M6)
  caseHistory: (id: string) => invoke<CommitInfo[]>("case_history", { id }),
  caseCommitDiff: (id: string, hash: string) =>
    invoke<CaseCommitDiff>("case_commit_diff", { id, hash }),
  caseBlame: (id: string) => invoke<BlameLine[]>("case_blame", { id }),
  restoreCaseVersion: (id: string, hash: string) =>
    invoke<TestCase>("restore_case_version", { id, hash }),

  lfsStatus: () => invoke<LfsStatus>("lfs_status"),
  enableLfs: () => invoke<LfsStatus>("enable_lfs"),
  disableLfs: () => invoke<LfsStatus>("disable_lfs"),

  checkForUpdate: () => invoke<UpdateInfo>("check_for_update"),
  installUpdate: () => invoke<void>("install_update"),
};

// ---- Playwright run lifecycle events -----------------------------------------
// The Rust side streams these while a run executes (docs/02-architecture.md §2.4).

export const runEvents = {
  onStarted: (cb: (e: RunStartedEvent) => void): Promise<UnlistenFn> =>
    listen<RunStartedEvent>("run://started", (e) => cb(e.payload)),
  onLog: (cb: (e: RunLogEvent) => void): Promise<UnlistenFn> =>
    listen<RunLogEvent>("run://log", (e) => cb(e.payload)),
  onProgress: (cb: (e: RunProgressEvent) => void): Promise<UnlistenFn> =>
    listen<RunProgressEvent>("run://progress", (e) => cb(e.payload)),
  onFinished: (cb: (e: RunFinishedEvent) => void): Promise<UnlistenFn> =>
    listen<RunFinishedEvent>("run://finished", (e) => cb(e.payload)),
};

// ---- Agent lifecycle events --------------------------------------------------
// Emitted while a spec generation/update or a failure triage runs. Every event
// carries an `id` (the case id, or `<runId>:<caseId>` for triage) so a screen
// can subscribe to just its own agent activity.

export const agentEvents = {
  onStarted: (cb: (e: AgentStartedEvent) => void): Promise<UnlistenFn> =>
    listen<AgentStartedEvent>("agent://started", (e) => cb(e.payload)),
  onLog: (cb: (e: AgentLogEvent) => void): Promise<UnlistenFn> =>
    listen<AgentLogEvent>("agent://log", (e) => cb(e.payload)),
  onFinished: (cb: (e: AgentFinishedEvent) => void): Promise<UnlistenFn> =>
    listen<AgentFinishedEvent>("agent://finished", (e) => cb(e.payload)),
};

/** Normalize an IPC error (a plain string from the Rust side) to a message. */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
