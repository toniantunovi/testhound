//! Pure domain types and business rules. No I/O.
//!
//! These mirror the on-disk file schema in docs/03-data-model.md. Enums use
//! lowercase serde renaming so the YAML stays human-readable and diff-friendly.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub mod steps;
pub use steps::{parse_body, Step};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Medium,
    High,
    Critical,
}

impl Default for Priority {
    fn default() -> Self {
        Priority::Medium
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaseType {
    Functional,
    Regression,
    Smoke,
    E2e,
    Negative,
    A11y,
    Perf,
}

impl Default for CaseType {
    fn default() -> Self {
        CaseType::Functional
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaseStatus {
    Draft,
    Active,
    Deprecated,
}

impl Default for CaseStatus {
    fn default() -> Self {
        CaseStatus::Active
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationState {
    None,
    Linked,
    Drifted,
    Generating,
    Failed,
}

impl Default for AutomationState {
    fn default() -> Self {
        AutomationState::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultStatus {
    Untested,
    Passed,
    Failed,
    Blocked,
    Retest,
    Skipped,
}

impl Default for ResultStatus {
    fn default() -> Self {
        ResultStatus::Untested
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Planned,
    InProgress,
    Complete,
    Archived,
}

impl Default for RunState {
    fn default() -> Self {
        RunState::Planned
    }
}

/// How a run selected the cases it contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IncludeMode {
    /// A hand-picked list of case ids.
    Explicit,
    /// A saved filter query, resolved to a snapshot at creation time.
    Filter,
    /// One or more whole suites.
    Suite,
}

impl Default for IncludeMode {
    fn default() -> Self {
        IncludeMode::Explicit
    }
}

/// Whether a result was recorded by a person or by automation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultSource {
    Manual,
    Automated,
}

impl Default for ResultSource {
    fn default() -> Self {
        ResultSource::Manual
    }
}

/// How a run selected its cases, plus the resolved snapshot of member ids. The
/// snapshot makes run membership stable and diff-friendly even though a filter
/// query would match differently as cases change over time.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Includes {
    #[serde(default)]
    pub mode: IncludeMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suites: Vec<String>,
    /// Resolved member case ids at creation time (authoritative membership).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cases: Vec<String>,
}

/// A test run: `runs/<id>/run.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub configuration: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub includes: Includes,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(default)]
    pub state: RunState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
}

/// One append-only attempt in a result's history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultHistoryEntry {
    pub at: String,
    pub status: ResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

/// A recorded result for one case in one run: `runs/<id>/results/<case>.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub case: String,
    #[serde(default)]
    pub status: ResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executed_at: Option<String>,
    #[serde(default)]
    pub source: ResultSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub defects: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<ResultHistoryEntry>,
}

/// A release milestone runs can target: `milestones/<id>.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default)]
    pub completed: bool,
}

/// A single option within a configuration group (e.g. a browser × form-factor).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    /// The Playwright `--project` this option maps to, if any. A configuration
    /// option is a TestHound reporting dimension, not a Playwright project;
    /// only when this is set does a run tagged with the option pass
    /// `--project=<value>` to Playwright. Unmapped options run the config's
    /// default project(s).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playwright_project: Option<String>,
}

/// A configuration group: `configurations/<id>.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Configuration {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<ConfigOption>,
}

/// Automation linkage block, embedded in each case's front matter for locality.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Automation {
    #[serde(default)]
    pub state: AutomationState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub specs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
}

/// The YAML front matter of a test case file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontMatter {
    pub id: String,
    pub title: String,
    pub suite: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(rename = "type", default)]
    pub kind: CaseType,
    #[serde(default)]
    pub status: CaseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<String>,
    #[serde(default)]
    pub automation: Automation,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub custom: BTreeMap<String, serde_yaml::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
}

/// A full test case: front matter + Markdown body, plus derived structure that
/// the UI renders (steps table, preconditions). Serialized to JSON for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCase {
    #[serde(flatten)]
    pub front: FrontMatter,
    /// Raw Markdown body (everything after the front matter).
    pub body: String,
    /// Parsed, ordered steps with optional expected results.
    pub steps: Vec<Step>,
    /// Parsed precondition lines.
    pub preconditions: Vec<String>,
}

/// A suite: `suites/<id>/suite.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suite {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub order: i64,
}

/// A section within a suite: `suites/<id>/sections/<sid>.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default)]
    pub order: i64,
}

/// Project configuration: `testhound/project.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    #[serde(default = "default_version")]
    pub version: i64,
    #[serde(default = "default_root")]
    pub root: String,
    #[serde(default = "default_next_case_id")]
    pub next_case_id: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub priorities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub case_types: Vec<String>,
}

fn default_version() -> i64 {
    1
}
fn default_root() -> String {
    "testhound".to_string()
}
fn default_next_case_id() -> u64 {
    1
}

impl Default for Project {
    fn default() -> Self {
        Project {
            name: "Untitled Project".to_string(),
            version: 1,
            root: "testhound".to_string(),
            next_case_id: 1,
            priorities: ["low", "medium", "high", "critical"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            case_types: [
                "functional",
                "regression",
                "smoke",
                "e2e",
                "negative",
                "a11y",
                "perf",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        }
    }
}
