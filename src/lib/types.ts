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
  elapsed: string | null;
  evidence: string[];
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

// ---- Playwright execution ----------------------------------------------------

export interface PlaywrightInfo {
  detected: boolean;
  config: string | null;
  localBinary: boolean;
}

export interface CaseOutcome {
  case: string;
  status: ResultStatus;
  elapsed: string | null;
  evidence: string[];
}

export interface PlaywrightSummary {
  runId: string;
  updated: CaseOutcome[];
  skipped: string[];
  unmapped: string[];
}

export interface RunLogEvent {
  runId: string;
  line: string;
}

export interface RunStartedEvent {
  runId: string;
  cases: number;
}

export interface RunProgressEvent {
  runId: string;
  case: string;
  status: ResultStatus;
  elapsed: string | null;
}

export interface RunFinishedEvent {
  runId: string;
  summary: PlaywrightSummary | null;
  error: string | null;
}

// ---- AI automation (M4) ------------------------------------------------------

export interface AgentAvailability {
  id: string;
  name: string;
  command: string;
  available: boolean;
}

export interface RepoContext {
  config: string | null;
  testsDir: string;
  baseUrl: string | null;
  nearbySpecs: string[];
  targetPath: string;
}

export interface CoverageRow {
  case: string;
  title: string;
  suite: string;
  priority: Priority;
  status: CaseStatus;
  state: AutomationState;
  specs: string[];
}

export interface SuiteCoverage {
  id: string;
  name: string;
  active: number;
  automated: number;
}

export interface Coverage {
  rows: CoverageRow[];
  orphans: string[];
  totalActive: number;
  automated: number;
  drifted: number;
  p1Unautomated: number;
  coveragePct: number;
  perSuite: SuiteCoverage[];
}

export interface FileDiff {
  path: string;
  old: string | null;
  newContent: string;
  isNew: boolean;
}

/** kind is "generate" | "update" | "triage". */
export interface AgentStartedEvent {
  id: string;
  kind: string;
}

export interface AgentLogEvent {
  id: string;
  line: string;
}

export interface AgentFinishedEvent {
  id: string;
  kind: string;
  changedSpecs: string[];
  output: string | null;
  error: string | null;
}

// ---- Collaboration: conflicts, semantic merge, LFS, updates (M5) -------------

export type Side = "base" | "ours" | "theirs";

export interface FieldMerge {
  key: string;
  label: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  conflict: boolean;
  suggested: Side;
}

export interface CaseMerge {
  path: string;
  id: string;
  title: string;
  fields: FieldMerge[];
  hasConflict: boolean;
  deletedSide?: Side;
}

export interface RawConflict {
  path: string;
}

export interface Conflicts {
  cases: CaseMerge[];
  other: RawConflict[];
}

export interface IdCollision {
  id: string;
  paths: string[];
}

export interface LfsStatus {
  lfsAvailable: boolean;
  enabled: boolean;
  patterns: string[];
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version: string | null;
  notes: string | null;
  /** Set when the updater is not configured or the check failed. */
  error: string | null;
}

// ---- Changes, history & diff (M6) --------------------------------------------

export interface CommitInfo {
  hash: string;
  short: string;
  author: string;
  email: string;
  /** RFC3339 author date. */
  when: string;
  message: string;
  summary: string;
}

export interface CaseCommitDiff {
  path: string;
  old: string | null;
  newContent: string;
  isNew: boolean;
  commit: CommitInfo;
  /** The commit changed step expectations and the case has a linked spec. */
  affectsSpec: boolean;
}

export interface BlameLine {
  line: number;
  short: string;
  author: string;
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
