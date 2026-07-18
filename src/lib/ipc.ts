// Typed wrappers over Tauri IPC commands. One function per Rust #[tauri::command].
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentAvailability,
  AgentFinishedEvent,
  AgentLogEvent,
  AgentStartedEvent,
  AssistantChunkEvent,
  AssistantFinishedEvent,
  BlameLine,
  ChatMessage,
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
  SyncOutcome,
  TestCase,
  TestTarget,
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

// The backend omits empty collections (serde `skip_serializing_if`), so a
// freshly created case arrives without `tags`/`steps`/etc. The TS types and the
// UI treat these as always-present arrays, so fill the defaults here at the IPC
// boundary rather than making every consumer defensive.
function normalizeCase(c: TestCase): TestCase {
  return {
    ...c,
    tags: c.tags ?? [],
    references: c.references ?? [],
    steps: c.steps ?? [],
    preconditions: c.preconditions ?? [],
    automation: c.automation ?? { state: "none" },
  };
}

// Same story for runs: a run created without configurations (or defined via a
// filter/explicit picks) arrives without `configuration` and the `includes`
// arrays, and RunView indexes into them directly.
function normalizeRun(r: Run): Run {
  return {
    ...r,
    configuration: r.configuration ?? [],
    includes: {
      mode: r.includes?.mode ?? "suite",
      query: r.includes?.query ?? null,
      suites: r.includes?.suites ?? [],
      cases: r.includes?.cases ?? [],
    },
  };
}

export const api = {
  inspectRepo: (path: string) => invoke<RepoInfo>("inspect_repo", { path }),
  cloneRepo: (url: string, dest: string) =>
    invoke<RepoInfo>("clone_repo", { url, dest }),
  scaffoldProject: (path: string, name: string, seed: boolean) =>
    invoke<ProjectInfo>("scaffold_project", { path, name, seed }),
  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
  currentProject: () => invoke<ProjectInfo | null>("current_project"),
  closeProject: () => invoke<void>("close_project"),

  listSuites: () => invoke<SuiteTree[]>("list_suites"),
  createSuite: (name: string) => invoke<string>("create_suite", { name }),
  renameSuite: (id: string, name: string) =>
    invoke<void>("rename_suite", { id, name }),
  deleteSuite: (id: string) => invoke<void>("delete_suite", { id }),
  renameSection: (suite: string, id: string, name: string) =>
    invoke<void>("rename_section", { suite, id, name }),
  deleteSection: (suite: string, id: string) =>
    invoke<void>("delete_section", { suite, id }),
  listCases: () => invoke<CaseSummary[]>("list_cases"),
  getCase: (id: string) =>
    invoke<TestCase>("get_case", { id }).then(normalizeCase),
  saveCase: (testCase: TestCase) =>
    invoke<TestCase>("save_case", { case: testCase }).then(normalizeCase),
  createCase: (suite: string, title: string) =>
    invoke<TestCase>("create_case", { suite, title }).then(normalizeCase),
  deleteCase: (id: string) => invoke<void>("delete_case", { id }),
  moveCase: (id: string, suite: string) =>
    invoke<TestCase>("move_case", { id, suite }).then(normalizeCase),
  duplicateCase: (id: string, suite?: string | null) =>
    invoke<TestCase>("duplicate_case", { id, suite: suite ?? null }).then(
      normalizeCase,
    ),

  gitStatus: () => invoke<GitStatus>("git_status"),
  listBranches: () => invoke<string[]>("list_branches"),
  switchBranch: (name: string) => invoke<GitStatus>("switch_branch", { name }),
  createBranch: (name: string) => invoke<GitStatus>("create_branch", { name }),

  dashboard: () => invoke<Dashboard>("dashboard"),

  listRuns: () => invoke<RunSummary[]>("list_runs"),
  getRun: (id: string) =>
    invoke<RunDetail>("get_run", { id }).then((d) => ({
      ...d,
      run: normalizeRun(d.run),
    })),
  previewRun: (
    mode: IncludeMode,
    query: string | null,
    suites: string[],
    cases: string[],
  ) => invoke<CaseSummary[]>("preview_run", { mode, query, suites, cases }),
  createRun: (input: CreateRunInput) =>
    invoke<Run>("create_run", { ...input }).then(normalizeRun),
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
    invoke<Run>("set_run_state", { runId, runState }).then(normalizeRun),

  listMilestones: () => invoke<Milestone[]>("list_milestones"),
  listConfigurations: () => invoke<Configuration[]>("list_configurations"),

  playwrightInfo: () => invoke<PlaywrightInfo>("playwright_info"),
  getTestTarget: () => invoke<TestTarget>("get_test_target"),
  setTestTarget: (target: TestTarget) =>
    invoke<void>("set_test_target", { target }),
  runPlaywright: (runId: string, headed: boolean) =>
    invoke<void>("run_playwright", { runId, headed }),
  runCaseSpec: (caseId: string, headed: boolean) =>
    invoke<void>("run_case_spec", { caseId, headed }),
  openTrace: (path: string) => invoke<void>("open_trace", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),

  // AI automation (M4)
  listAgents: () => invoke<AgentAvailability[]>("list_agents"),
  coverage: () => invoke<Coverage>("coverage"),
  automationContext: (id: string) =>
    invoke<RepoContext>("automation_context", { id }),
  generationPrompt: (id: string, update: boolean) =>
    invoke<string>("generation_prompt", { id, update }),
  automationSetup: () => invoke<string>("automation_setup"),
  saveAutomationSetup: (content: string) =>
    invoke<void>("save_automation_setup", { content }),
  fileDiff: (path: string) => invoke<FileDiff>("file_diff", { path }),
  readSpec: (path: string) => invoke<string>("read_spec", { path }),
  writeSpec: (path: string, content: string) =>
    invoke<void>("write_spec", { path, content }),
  generateSpec: (caseId: string, agentId: string, update: boolean) =>
    invoke<void>("generate_spec", { caseId, agentId, update }),
  acceptGeneration: (caseId: string, specs: string[], generator: string) =>
    invoke<TestCase>("accept_generation", { caseId, specs, generator }),
  linkGeneratedSpecs: (caseId: string, update: boolean, generator: string) =>
    invoke<TestCase | null>("link_generated_specs", {
      id: caseId,
      update,
      generator,
    }),
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
  syncRepo: () => invoke<SyncOutcome>("sync_repo"),
  mergeRemote: () => invoke<SyncOutcome>("merge_remote"),
  stashPop: () => invoke<SyncOutcome>("stash_pop"),
  completeMerge: () => invoke<string>("complete_merge"),

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

  // Conversational assistant panel. Streams `assistant://*` events; file changes
  // land in the working tree for review in the Changes panel.
  assistantSend: (args: {
    turnId: string;
    agentId: string;
    message: string;
    sessionId: string | null;
    history: ChatMessage[];
  }) => invoke<void>("assistant_send", args),
  assistantStop: () => invoke<void>("assistant_stop"),
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

// ---- Assistant streaming events ----------------------------------------------

export const assistantEvents = {
  onChunk: (cb: (e: AssistantChunkEvent) => void): Promise<UnlistenFn> =>
    listen<AssistantChunkEvent>("assistant://chunk", (e) => cb(e.payload)),
  onFinished: (cb: (e: AssistantFinishedEvent) => void): Promise<UnlistenFn> =>
    listen<AssistantFinishedEvent>("assistant://finished", (e) => cb(e.payload)),
};

/** Normalize an IPC error (a plain string from the Rust side) to a message. */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
