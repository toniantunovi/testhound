//! Tauri command handlers, app state, and orchestration.

pub mod sample;

use crate::error::{Error, Result};
use crate::git;
use crate::playwright::{self, PlaywrightInfo};
use crate::repo::runs::{self, CreateRun, RunDetail, RunSummary};
use crate::repo::{self, CaseSummary, Paths, SuiteTree};
use crate::domain::{
    Configuration, IncludeMode, Milestone, Project, ResultSource, ResultStatus, Run, RunResult,
    RunState, TestCase,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// The currently open project. libgit2's `Repository` is not thread-safe, so we
/// store only paths here and open the repo on demand inside each command.
pub struct Open {
    pub paths: Paths,
    /// Whether a Playwright install was detected; consumed by later milestones.
    #[allow(dead_code)]
    pub playwright: bool,
}

#[derive(Default)]
pub struct AppState {
    pub open: Mutex<Option<Open>>,
}

impl AppState {
    fn paths(&self) -> Result<Paths> {
        self.open
            .lock()
            .unwrap()
            .as_ref()
            .map(|o| o.paths.clone())
            .ok_or(Error::NoProjectOpen)
    }
}

// ---- DTOs sent to the frontend ------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub is_git_repo: bool,
    pub has_project: bool,
    pub project_name: Option<String>,
    pub playwright_detected: bool,
    pub th_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub repo_root: String,
    pub th_dir: String,
    pub branch: String,
    pub playwright_detected: bool,
}

fn detect_playwright(repo_root: &Path) -> bool {
    playwright::detect(repo_root).detected
}

fn inspect(repo_root: &Path) -> RepoInfo {
    let is_git = git::is_repo(repo_root);
    let th_dir = repo::detect(repo_root);
    let project_name = th_dir.as_ref().and_then(|d| {
        let paths = Paths::new(repo_root, d);
        repo::load_project(&paths).ok().map(|p| p.name)
    });
    RepoInfo {
        path: repo_root.display().to_string(),
        is_git_repo: is_git,
        has_project: th_dir.is_some(),
        project_name,
        playwright_detected: detect_playwright(repo_root),
        th_dir,
    }
}

fn project_info(paths: &Paths, project: &Project) -> Result<ProjectInfo> {
    let repo = git::open(&paths.root)?;
    Ok(ProjectInfo {
        name: project.name.clone(),
        repo_root: paths.root.display().to_string(),
        th_dir: project.root.clone(),
        branch: git::current_branch(&repo)?,
        playwright_detected: detect_playwright(&paths.root),
    })
}

// ---- Commands -----------------------------------------------------------------

#[tauri::command]
pub fn inspect_repo(path: String) -> Result<RepoInfo> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(Error::NotADirectory(path));
    }
    Ok(inspect(&root))
}

#[tauri::command]
pub fn clone_repo(url: String, dest: String) -> Result<RepoInfo> {
    let dest = PathBuf::from(&dest);
    git::clone(&url, &dest)?;
    Ok(inspect(&dest))
}

#[tauri::command]
pub fn scaffold_project(
    path: String,
    name: String,
    seed: bool,
    state: tauri::State<AppState>,
) -> Result<ProjectInfo> {
    let root = PathBuf::from(&path);
    git::init_if_needed(&root)?;
    let th_dir = repo::detect(&root).unwrap_or_else(|| "testhound".to_string());
    let project = repo::scaffold(&root, &name, &th_dir)?;
    let paths = Paths::new(&root, &th_dir);
    if seed {
        sample::seed(&paths)?;
    }
    let info = project_info(&paths, &project)?;
    *state.open.lock().unwrap() = Some(Open {
        paths,
        playwright: info.playwright_detected,
    });
    Ok(info)
}

#[tauri::command]
pub fn open_project(path: String, state: tauri::State<AppState>) -> Result<ProjectInfo> {
    let root = PathBuf::from(&path);
    let th_dir = repo::detect(&root)
        .ok_or_else(|| Error::InvalidFormat("no testhound/ project in this repo".into()))?;
    let paths = Paths::new(&root, &th_dir);
    let project = repo::load_project(&paths)?;
    let info = project_info(&paths, &project)?;
    *state.open.lock().unwrap() = Some(Open {
        paths,
        playwright: info.playwright_detected,
    });
    Ok(info)
}

#[tauri::command]
pub fn current_project(state: tauri::State<AppState>) -> Result<Option<ProjectInfo>> {
    let guard = state.open.lock().unwrap();
    let Some(open) = guard.as_ref() else {
        return Ok(None);
    };
    let project = repo::load_project(&open.paths)?;
    Ok(Some(project_info(&open.paths, &project)?))
}

#[tauri::command]
pub fn list_suites(state: tauri::State<AppState>) -> Result<Vec<SuiteTree>> {
    repo::list_suites(&state.paths()?)
}

#[tauri::command]
pub fn list_cases(state: tauri::State<AppState>) -> Result<Vec<CaseSummary>> {
    repo::list_cases(&state.paths()?)
}

#[tauri::command]
pub fn get_case(id: String, state: tauri::State<AppState>) -> Result<TestCase> {
    repo::load_case(&state.paths()?, &id)
}

#[tauri::command]
pub fn save_case(case: TestCase, state: tauri::State<AppState>) -> Result<TestCase> {
    repo::save_case(&state.paths()?, &case)
}

#[tauri::command]
pub fn create_case(
    suite: String,
    title: String,
    state: tauri::State<AppState>,
) -> Result<TestCase> {
    let paths = state.paths()?;
    let id = repo::next_case_id(&paths)?;
    let body = "## Preconditions\n- \n\n## Steps\n1. \n   - **Expected:** \n";
    let case = repo::new_case(id, title, suite, body);
    repo::save_case(&paths, &case)
}

#[tauri::command]
pub fn git_status(state: tauri::State<AppState>) -> Result<git::GitStatus> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    git::status(&repo)
}

#[tauri::command]
pub fn list_branches(state: tauri::State<AppState>) -> Result<Vec<String>> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    git::branches(&repo)
}

#[tauri::command]
pub fn switch_branch(name: String, state: tauri::State<AppState>) -> Result<git::GitStatus> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    git::checkout_branch(&repo, &name)?;
    git::status(&repo)
}

// ---- Runs & results -----------------------------------------------------------

#[tauri::command]
pub fn list_runs(state: tauri::State<AppState>) -> Result<Vec<RunSummary>> {
    runs::list_runs(&state.paths()?)
}

#[tauri::command]
pub fn get_run(id: String, state: tauri::State<AppState>) -> Result<RunDetail> {
    runs::load_run(&state.paths()?, &id)
}

/// Resolve a run definition to the cases it would include, without saving.
/// Powers the live preview in the New Run builder.
#[tauri::command]
pub fn preview_run(
    mode: IncludeMode,
    query: Option<String>,
    suites: Vec<String>,
    cases: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<CaseSummary>> {
    let paths = state.paths()?;
    let all = repo::list_cases(&paths)?;
    let ids: std::collections::HashSet<String> =
        runs::resolve_includes(&all, mode, query.as_deref(), &suites, &cases)
            .into_iter()
            .collect();
    Ok(all.into_iter().filter(|c| ids.contains(&c.id)).collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_run(
    name: String,
    milestone: Option<String>,
    configuration: Vec<String>,
    description: Option<String>,
    assignee: Option<String>,
    mode: IncludeMode,
    query: Option<String>,
    suites: Vec<String>,
    cases: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Run> {
    let paths = state.paths()?;
    runs::create_run(
        &paths,
        CreateRun {
            name,
            milestone,
            configuration,
            description,
            assignee,
            mode,
            query,
            suites,
            cases,
        },
    )
}

#[tauri::command]
pub fn set_result(
    run_id: String,
    case_id: String,
    status: ResultStatus,
    comment: Option<String>,
    executed_by: Option<String>,
    state: tauri::State<AppState>,
) -> Result<RunResult> {
    runs::set_result(
        &state.paths()?,
        &run_id,
        &case_id,
        status,
        comment,
        executed_by,
        ResultSource::Manual,
    )
}

#[tauri::command]
pub fn set_run_state(
    run_id: String,
    run_state: RunState,
    state: tauri::State<AppState>,
) -> Result<Run> {
    runs::set_run_state(&state.paths()?, &run_id, run_state)
}

#[tauri::command]
pub fn list_milestones(state: tauri::State<AppState>) -> Result<Vec<Milestone>> {
    runs::list_milestones(&state.paths()?)
}

#[tauri::command]
pub fn list_configurations(state: tauri::State<AppState>) -> Result<Vec<Configuration>> {
    runs::list_configurations(&state.paths()?)
}

// ---- Playwright execution -----------------------------------------------------

/// Detected Playwright install info for the open repo.
#[tauri::command]
pub fn playwright_info(state: tauri::State<AppState>) -> Result<PlaywrightInfo> {
    Ok(playwright::detect(&state.paths()?.root))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    run_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedEvent {
    run_id: String,
    cases: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    run_id: String,
    case: String,
    status: ResultStatus,
    elapsed: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedEvent {
    run_id: String,
    summary: Option<playwright::Summary>,
    error: Option<String>,
}

/// Run the Playwright specs linked to a run's cases, streaming lifecycle to the
/// UI and ingesting results as `source: automated`. Returns immediately; the
/// work runs on a background thread and reports via `run://*` events
/// (docs/02-architecture.md §2.4).
#[tauri::command]
pub fn run_playwright(run_id: String, app: AppHandle, state: tauri::State<AppState>) -> Result<()> {
    let paths = state.paths()?;
    let run = runs::load_run(&paths, &run_id)?.run;
    let _ = app.emit(
        "run://started",
        StartedEvent {
            run_id: run_id.clone(),
            cases: run.includes.cases.len(),
        },
    );

    std::thread::spawn(move || {
        let log_app = app.clone();
        let log_id = run_id.clone();
        let result = playwright::execute(&paths, &run, Some("playwright"), |line| {
            let _ = log_app.emit(
                "run://log",
                LogEvent {
                    run_id: log_id.clone(),
                    line: line.to_string(),
                },
            );
        });

        let finished = match result {
            Ok(summary) => {
                for outcome in &summary.updated {
                    let _ = app.emit(
                        "run://progress",
                        ProgressEvent {
                            run_id: run_id.clone(),
                            case: outcome.case.clone(),
                            status: outcome.status,
                            elapsed: outcome.elapsed.clone(),
                        },
                    );
                }
                FinishedEvent {
                    run_id: run_id.clone(),
                    summary: Some(summary),
                    error: None,
                }
            }
            Err(e) => {
                let msg = e.to_string();
                let _ = app.emit(
                    "run://log",
                    LogEvent {
                        run_id: run_id.clone(),
                        line: format!("error: {msg}"),
                    },
                );
                FinishedEvent {
                    run_id: run_id.clone(),
                    summary: None,
                    error: Some(msg),
                }
            }
        };
        let _ = app.emit("run://finished", finished);
    });

    Ok(())
}

/// Open a Playwright trace artifact in the trace viewer.
#[tauri::command]
pub fn open_trace(path: String, state: tauri::State<AppState>) -> Result<()> {
    playwright::show_trace(&state.paths()?, &path)
}

/// Aggregate dashboard KPIs derived from the file store (cheap, on demand).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub active_cases: usize,
    pub total_cases: usize,
    pub automated: usize,
    pub drifted: usize,
    pub coverage_pct: u32,
    pub suites: Vec<SuiteHealth>,
    /// Pass rate of the most recent run that has any executed results.
    pub last_run_pass_rate: Option<u32>,
    pub last_run_failed: usize,
    /// High/critical priority cases with no automation yet.
    pub p1_unautomated: usize,
    /// The most recent runs (newest first), capped for the dashboard list.
    pub runs: Vec<RunSummary>,
    /// Pass rate per executed run, oldest -> newest, for the trend chart.
    pub pass_rate_trend: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteHealth {
    pub id: String,
    pub name: String,
    pub case_count: usize,
    pub automated: usize,
}

#[tauri::command]
pub fn dashboard(state: tauri::State<AppState>) -> Result<Dashboard> {
    use crate::domain::{AutomationState, CaseStatus, Priority};
    let paths = state.paths()?;
    let cases = repo::list_cases(&paths)?;
    let suites = repo::list_suites(&paths)?;
    let all_runs = runs::list_runs(&paths)?;

    let total = cases.len();
    let active = cases
        .iter()
        .filter(|c| c.status == CaseStatus::Active)
        .count();
    let automated = cases
        .iter()
        .filter(|c| matches!(c.automation_state, AutomationState::Linked | AutomationState::Drifted))
        .count();
    let drifted = cases
        .iter()
        .filter(|c| c.automation_state == AutomationState::Drifted)
        .count();
    let coverage = if active > 0 {
        ((automated as f64 / active as f64) * 100.0).round() as u32
    } else {
        0
    };

    let suite_health = suites
        .iter()
        .map(|s| {
            let auto = cases
                .iter()
                .filter(|c| {
                    c.suite == s.id
                        && matches!(
                            c.automation_state,
                            AutomationState::Linked | AutomationState::Drifted
                        )
                })
                .count();
            SuiteHealth {
                id: s.id.clone(),
                name: s.name.clone(),
                case_count: s.case_count,
                automated: auto,
            }
        })
        .collect();

    let p1_unautomated = cases
        .iter()
        .filter(|c| {
            matches!(c.priority, Priority::High | Priority::Critical)
                && c.automation_state == AutomationState::None
        })
        .count();

    // "Executed" runs have at least one non-untested result.
    let executed = |r: &&RunSummary| r.progress.total > r.progress.untested;
    let last_executed = all_runs.iter().find(executed);
    let last_run_pass_rate = last_executed.map(|r| r.progress.pass_rate());
    let last_run_failed = last_executed.map(|r| r.progress.failed).unwrap_or(0);

    // Trend: pass rate of each executed run in chronological order (list is
    // newest-first), trimmed to the most recent 15 points.
    let mut trend: Vec<u32> = all_runs
        .iter()
        .filter(executed)
        .map(|r| r.progress.pass_rate())
        .collect();
    trend.reverse();
    if trend.len() > 15 {
        trend = trend[trend.len() - 15..].to_vec();
    }

    let runs = all_runs.into_iter().take(5).collect();

    Ok(Dashboard {
        active_cases: active,
        total_cases: total,
        automated,
        drifted,
        coverage_pct: coverage,
        suites: suite_health,
        last_run_pass_rate,
        last_run_failed,
        p1_unautomated,
        runs,
        pass_rate_trend: trend,
    })
}
