// TypeScript mirrors of the Rust DTOs (serde camelCase). Keep in sync with
// src-tauri/src/{domain,repo,git,app}.

export type Priority = "low" | "medium" | "high" | "critical";
export type CaseType =
  | "functional"
  | "regression"
  | "smoke"
  | "e2e"
  | "negative"
  | "a11y"
  | "perf";
export type CaseStatus = "draft" | "active" | "deprecated";
export type AutomationState =
  | "none"
  | "linked"
  | "drifted"
  | "generating"
  | "failed";
export type ResultStatus =
  | "untested"
  | "passed"
  | "failed"
  | "blocked"
  | "retest"
  | "skipped";

export interface RepoInfo {
  path: string;
  isGitRepo: boolean;
  hasProject: boolean;
  projectName: string | null;
  playwrightDetected: boolean;
  thDir: string | null;
}

export interface ProjectInfo {
  name: string;
  repoRoot: string;
  thDir: string;
  branch: string;
  playwrightDetected: boolean;
}

export interface Section {
  id: string;
  name: string;
  parent: string | null;
  order: number;
}

export interface SuiteTree {
  id: string;
  name: string;
  order: number;
  caseCount: number;
  sections: Section[];
}

export interface CaseSummary {
  id: string;
  title: string;
  suite: string;
  section: string | null;
  priority: Priority;
  type: CaseType;
  status: CaseStatus;
  owner: string | null;
  tags: string[];
  automationState: AutomationState;
  updated: string | null;
  path: string;
}

export interface Step {
  number: number;
  action: string;
  expected?: string;
}

export interface Automation {
  state: AutomationState;
  specs?: string[];
  last_synced?: string;
  source_hash?: string;
  generator?: string;
}

// TestCase is serialized with the front matter flattened at the top level.
export interface TestCase {
  id: string;
  title: string;
  suite: string;
  section?: string | null;
  priority: Priority;
  type: CaseType;
  status: CaseStatus;
  owner?: string | null;
  tags: string[];
  references: string[];
  estimate?: string | null;
  automation: Automation;
  custom?: Record<string, unknown>;
  created?: string | null;
  updated?: string | null;
  body: string;
  steps: Step[];
  preconditions: string[];
}

export interface ChangedFile {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  changed: ChangedFile[];
  detached: boolean;
}

export interface SuiteHealth {
  id: string;
  name: string;
  caseCount: number;
  automated: number;
}

// ---- Runs & results ----------------------------------------------------------

export type RunState = "planned" | "in_progress" | "complete" | "archived";
export type IncludeMode = "explicit" | "filter" | "suite";
export type ResultSource = "manual" | "automated";

export interface RunProgress {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  retest: number;
  skipped: number;
  untested: number;
}

export interface Includes {
  mode: IncludeMode;
  query?: string | null;
  suites?: string[];
  cases?: string[];
}

export interface Run {
  id: string;
  name: string;
  milestone?: string | null;
  configuration: string[];
  description?: string | null;
  includes: Includes;
  assignee?: string | null;
  state: RunState;
  created?: string | null;
  updated?: string | null;
}

export interface RunSummary {
  id: string;
  name: string;
  milestone: string | null;
  configuration: string[];
  assignee: string | null;
  state: RunState;
  created: string | null;
  progress: RunProgress;
}

export interface RunResultRow {
  case: string;
  title: string;
  suite: string;
  section: string | null;
  priority: Priority;
  automationState: AutomationState;
  status: ResultStatus;
  source: ResultSource;
  comment: string | null;
  executedBy: string | null;
  executedAt: string | null;
  attempts: number;
}

export interface RunDetail {
  run: Run;
  rows: RunResultRow[];
  progress: RunProgress;
}

export interface Milestone {
  id: string;
  name: string;
  description?: string | null;
  due?: string | null;
  completed: boolean;
}

export interface ConfigOption {
  id: string;
  name: string;
}

export interface Configuration {
  id: string;
  name: string;
  options: ConfigOption[];
}

export interface Dashboard {
  activeCases: number;
  totalCases: number;
  automated: number;
  drifted: number;
  coveragePct: number;
  suites: SuiteHealth[];
  lastRunPassRate: number | null;
  lastRunFailed: number;
  p1Unautomated: number;
  runs: RunSummary[];
  passRateTrend: number[];
}
