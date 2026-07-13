//! Tauri command handlers, app state, and orchestration.

pub mod sample;

use crate::assistant;
use crate::automation::{
    self,
    agent::{self, AgentAvailability, AgentKind, Mode},
    Coverage, RepoContext,
};
use crate::error::{Error, Result};
use crate::git;
use crate::lfs::{self, LfsStatus};
use crate::merge::{self, Conflicts, IdCollision, Side};
use crate::playwright::{self, PlaywrightInfo, TestTarget};
use crate::repo::runs::{self, CreateRun, RunDetail, RunSummary};
use crate::repo::{self, CaseSummary, Paths, SuiteTree};
use crate::domain::{
    Configuration, IncludeMode, Milestone, Project, ResultSource, ResultStatus, Run, RunResult,
    RunState, Suite, TestCase,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
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
    /// The assistant's currently-running agent child, if any, so it can be
    /// stopped mid-run. Only one assistant turn runs at a time.
    pub assistant_child: Arc<Mutex<Option<Child>>>,
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
pub async fn current_project(state: tauri::State<'_, AppState>) -> Result<Option<ProjectInfo>> {
    let guard = state.open.lock().unwrap();
    let Some(open) = guard.as_ref() else {
        return Ok(None);
    };
    let project = repo::load_project(&open.paths)?;
    Ok(Some(project_info(&open.paths, &project)?))
}

/// Create a new test suite from a display name. The id is a slug of the name;
/// errors if a suite with that id already exists. Returns the new suite id. The
/// change lands in the working tree for review in the Changes panel.
#[tauri::command]
pub async fn create_suite(name: String, state: tauri::State<'_, AppState>) -> Result<String> {
    let paths = state.paths()?;
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Other("suite name is empty".into()));
    }
    let id = slug::slugify(name);
    if id.is_empty() {
        return Err(Error::Other("suite name has no usable characters".into()));
    }
    let existing = repo::list_suites(&paths)?;
    if existing.iter().any(|s| s.id == id) {
        return Err(Error::Other(format!(
            "a suite \"{name}\" already exists"
        )));
    }
    let suite = Suite {
        id: id.clone(),
        name: name.to_string(),
        description: None,
        order: existing.len() as i64,
    };
    repo::create_suite(&paths, &suite)?;
    Ok(id)
}

#[tauri::command]
pub async fn list_suites(state: tauri::State<'_, AppState>) -> Result<Vec<SuiteTree>> {
    repo::list_suites(&state.paths()?)
}

#[tauri::command]
pub async fn list_cases(state: tauri::State<'_, AppState>) -> Result<Vec<CaseSummary>> {
    repo::list_cases(&state.paths()?)
}

#[tauri::command]
pub async fn get_case(id: String, state: tauri::State<'_, AppState>) -> Result<TestCase> {
    repo::load_case(&state.paths()?, &id)
}

#[tauri::command]
pub async fn save_case(case: TestCase, state: tauri::State<'_, AppState>) -> Result<TestCase> {
    repo::save_case(&state.paths()?, &case)
}

#[tauri::command]
pub async fn create_case(
    suite: String,
    title: String,
    state: tauri::State<'_, AppState>,
) -> Result<TestCase> {
    let paths = state.paths()?;
    let id = repo::next_case_id(&paths)?;
    let body = "## Preconditions\n- \n\n## Steps\n1. \n   - **Expected:** \n";
    let case = repo::new_case(id, title, suite, body);
    repo::save_case(&paths, &case)
}

/// Delete a test case: remove its file and drop its `automation/links.yml`
/// entry. The change lands in the working tree for review in the Changes panel;
/// nothing is committed.
#[tauri::command]
pub async fn delete_case(id: String, state: tauri::State<'_, AppState>) -> Result<()> {
    let paths = state.paths()?;
    repo::delete_case(&paths, &id)?;
    automation::remove_link(&paths, &id)?;
    Ok(())
}

#[tauri::command]
pub async fn git_status(state: tauri::State<'_, AppState>) -> Result<git::GitStatus> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    git::status(&repo)
}

#[tauri::command]
pub async fn list_branches(state: tauri::State<'_, AppState>) -> Result<Vec<String>> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    git::branches(&repo)
}

#[tauri::command]
pub async fn switch_branch(name: String, state: tauri::State<'_, AppState>) -> Result<git::GitStatus> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    git::checkout_branch(&repo, &name)?;
    git::status(&repo)
}

// ---- Runs & results -----------------------------------------------------------

#[tauri::command]
pub async fn list_runs(state: tauri::State<'_, AppState>) -> Result<Vec<RunSummary>> {
    runs::list_runs(&state.paths()?)
}

#[tauri::command]
pub async fn get_run(id: String, state: tauri::State<'_, AppState>) -> Result<RunDetail> {
    runs::load_run(&state.paths()?, &id)
}

/// Resolve a run definition to the cases it would include, without saving.
/// Powers the live preview in the New Run builder.
#[tauri::command]
pub async fn preview_run(
    mode: IncludeMode,
    query: Option<String>,
    suites: Vec<String>,
    cases: Vec<String>,
    state: tauri::State<'_, AppState>,
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
pub async fn create_run(
    name: String,
    milestone: Option<String>,
    configuration: Vec<String>,
    description: Option<String>,
    assignee: Option<String>,
    mode: IncludeMode,
    query: Option<String>,
    suites: Vec<String>,
    cases: Vec<String>,
    state: tauri::State<'_, AppState>,
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
pub async fn set_result(
    run_id: String,
    case_id: String,
    status: ResultStatus,
    comment: Option<String>,
    executed_by: Option<String>,
    state: tauri::State<'_, AppState>,
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
pub async fn set_run_state(
    run_id: String,
    run_state: RunState,
    state: tauri::State<'_, AppState>,
) -> Result<Run> {
    runs::set_run_state(&state.paths()?, &run_id, run_state)
}

#[tauri::command]
pub async fn list_milestones(state: tauri::State<'_, AppState>) -> Result<Vec<Milestone>> {
    runs::list_milestones(&state.paths()?)
}

#[tauri::command]
pub async fn list_configurations(state: tauri::State<'_, AppState>) -> Result<Vec<Configuration>> {
    runs::list_configurations(&state.paths()?)
}

// ---- Playwright execution -----------------------------------------------------

/// Detected Playwright install info for the open repo.
#[tauri::command]
pub async fn playwright_info(state: tauri::State<'_, AppState>) -> Result<PlaywrightInfo> {
    Ok(playwright::detect(&state.paths()?.root))
}

/// The configured test target (base URL + env) that runs are directed to.
#[tauri::command]
pub async fn get_test_target(state: tauri::State<'_, AppState>) -> Result<TestTarget> {
    Ok(playwright::load_target(&state.paths()?))
}

/// Save the test target. Stored locally (gitignored) so it can point at a
/// personal environment or hold secrets without being committed.
#[tauri::command]
pub async fn set_test_target(
    target: TestTarget,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    playwright::save_target(&state.paths()?, &target)
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
pub fn run_playwright(
    run_id: String,
    headed: bool,
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<()> {
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
        let result = playwright::execute(&paths, &run, Some("playwright"), headed, |line| {
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

/// Run a single case's linked spec ad-hoc to watch it, WITHOUT creating a run or
/// recording results. Streams output through the same `run://*` events as a real
/// run (keyed by a synthetic `preview:<case>` id) so it shows in the Activity
/// console; nothing is persisted.
#[tauri::command]
pub fn run_case_spec(
    case_id: String,
    headed: bool,
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<()> {
    let paths = state.paths()?;
    let case = repo::load_case(&paths, &case_id)?;
    let specs = case.front.automation.specs.clone();
    if specs.is_empty() {
        return Err(Error::Playwright(format!(
            "{case_id} has no linked spec to run"
        )));
    }
    let preview_id = format!("preview:{case_id}");
    let _ = app.emit(
        "run://started",
        StartedEvent {
            run_id: preview_id.clone(),
            cases: 1,
        },
    );

    std::thread::spawn(move || {
        let log_app = app.clone();
        let log_id = preview_id.clone();
        let result = playwright::run_spec_preview(&paths, &specs, headed, |line| {
            let _ = log_app.emit(
                "run://log",
                LogEvent {
                    run_id: log_id.clone(),
                    line: line.to_string(),
                },
            );
        });
        let error = match result {
            Ok(()) => {
                let _ = app.emit(
                    "run://log",
                    LogEvent {
                        run_id: preview_id.clone(),
                        line: "Preview finished.".to_string(),
                    },
                );
                None
            }
            Err(e) => {
                let msg = e.to_string();
                let _ = app.emit(
                    "run://log",
                    LogEvent {
                        run_id: preview_id.clone(),
                        line: format!("error: {msg}"),
                    },
                );
                Some(msg)
            }
        };
        let _ = app.emit(
            "run://finished",
            FinishedEvent {
                run_id: preview_id.clone(),
                summary: None,
                error,
            },
        );
    });

    Ok(())
}

/// Open a Playwright trace artifact in the trace viewer.
#[tauri::command]
pub fn open_trace(path: String, state: tauri::State<AppState>) -> Result<()> {
    playwright::show_trace(&state.paths()?, &path)
}

// ---- AI automation (docs/05-ai-automation.md, roadmap M4) ---------------------

/// Which coding agents (Claude Code / Codex) are installed on PATH.
#[tauri::command]
pub fn list_agents() -> Vec<AgentAvailability> {
    agent::detect_agents()
}

/// The coverage & linking view: every case's automation state, orphan specs,
/// and roll-up metrics.
#[tauri::command]
pub async fn coverage(state: tauri::State<'_, AppState>) -> Result<Coverage> {
    automation::coverage(&state.paths()?)
}

/// The repo context TestHound would feed an agent when generating a case's spec.
#[tauri::command]
pub async fn automation_context(id: String, state: tauri::State<'_, AppState>) -> Result<RepoContext> {
    let paths = state.paths()?;
    let case = repo::load_case(&paths, &id)?;
    Ok(automation::detect_context(&paths, &case))
}

/// A file's working-tree contents alongside its committed version, for the
/// generated-spec diff view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old: Option<String>,
    pub new_content: String,
    pub is_new: bool,
}

#[tauri::command]
pub async fn file_diff(path: String, state: tauri::State<'_, AppState>) -> Result<FileDiff> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    let old = git::read_head_file(&repo, &path);
    let new_content = std::fs::read_to_string(paths.root.join(&path)).unwrap_or_default();
    Ok(FileDiff {
        is_new: old.is_none(),
        old,
        path,
        new_content,
    })
}

/// Resolve a repo-relative file path for direct read/write from the UI,
/// rejecting absolute paths and any traversal outside the repo root.
fn resolve_repo_file(paths: &Paths, path: &str) -> Result<PathBuf> {
    use std::path::Component;
    let rel = Path::new(path);
    let escapes = rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)));
    if escapes {
        return Err(Error::Other(format!("invalid path: {path}")));
    }
    Ok(paths.root.join(rel))
}

/// A linked spec's working-tree source, for the in-app code editor.
#[tauri::command]
pub async fn read_spec(path: String, state: tauri::State<'_, AppState>) -> Result<String> {
    let paths = state.paths()?;
    let file = resolve_repo_file(&paths, &path)?;
    if !file.is_file() {
        return Err(Error::Playwright(format!("spec not found on disk: {path}")));
    }
    Ok(std::fs::read_to_string(file)?)
}

/// Overwrite a linked spec from the in-app code editor. Edit-only by design:
/// the file must already exist, and the change lands in the working tree like
/// any other edit, to be reviewed and committed in the Changes panel.
#[tauri::command]
pub async fn write_spec(
    path: String,
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let paths = state.paths()?;
    let file = resolve_repo_file(&paths, &path)?;
    if !file.is_file() {
        return Err(Error::Playwright(format!("spec not found on disk: {path}")));
    }
    std::fs::write(file, content)?;
    Ok(())
}

/// Link accepted specs to a case (front matter + `links.yml`).
#[tauri::command]
pub fn accept_generation(
    case_id: String,
    specs: Vec<String>,
    generator: String,
    state: tauri::State<AppState>,
) -> Result<TestCase> {
    automation::accept_generation(&state.paths()?, &case_id, specs, &generator)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStartedEvent {
    id: String,
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentLogEvent {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentFinishedEvent {
    id: String,
    kind: String,
    /// For generate/update: spec files the agent created or modified.
    changed_specs: Vec<String>,
    /// For triage: the agent's classification + suggestion text.
    output: Option<String>,
    error: Option<String>,
}

// ---- Assistant panel ----------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantChunkEvent {
    /// The turn id this chunk belongs to (so the panel ignores stale turns).
    turn_id: String,
    /// `"text"` (assistant prose), `"tool"` (activity), or `"log"` (raw line).
    kind: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantFinishedEvent {
    turn_id: String,
    /// The final answer text.
    reply: String,
    /// Session id to resume the conversation on the next turn (Claude Code).
    session_id: Option<String>,
    error: Option<String>,
}

/// Send one message to the conversational assistant. Runs the chosen agent
/// (Claude Code / Codex) against the repo on a background thread with a broad,
/// auto-accepting tool scope, streaming `assistant://*` events. File changes
/// land in the working tree for the user to review in the Changes panel; nothing
/// is committed. `session_id` (returned by the previous turn) resumes the
/// conversation; `history` gives agents without native resume the transcript.
#[tauri::command]
pub async fn assistant_send(
    turn_id: String,
    agent_id: String,
    message: String,
    session_id: Option<String>,
    history: Vec<assistant::ChatMessage>,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let paths = state.paths()?;
    let kind = AgentKind::from_id(&agent_id)
        .ok_or_else(|| Error::Agent(format!("unknown agent: {agent_id}")))?;
    let turn = assistant::build_turn(kind, &paths, &history, &message, session_id.is_some());
    let child_slot = state.assistant_child.clone();

    std::thread::spawn(move || {
        let emit_app = app.clone();
        let emit_id = turn_id.clone();
        let result = agent::run_chat(
            &paths.root,
            kind,
            &turn.prompt,
            session_id.as_deref(),
            turn.system.as_deref(),
            child_slot,
            |ev| {
                let (kind, text) = match ev {
                    agent::ChatEvent::Text(t) => ("text", t),
                    agent::ChatEvent::Tool(t) => ("tool", t),
                    agent::ChatEvent::Log(t) => ("log", t),
                    // `Done` is consumed inside run_chat; never forwarded here.
                    agent::ChatEvent::Done { .. } => return,
                };
                let _ = emit_app.emit(
                    "assistant://chunk",
                    AssistantChunkEvent {
                        turn_id: emit_id.clone(),
                        kind: kind.to_string(),
                        text,
                    },
                );
            },
        );

        let finished = match result {
            Ok(outcome) => AssistantFinishedEvent {
                turn_id: turn_id.clone(),
                reply: outcome.reply,
                session_id: outcome.session_id,
                error: None,
            },
            Err(e) => AssistantFinishedEvent {
                turn_id: turn_id.clone(),
                reply: String::new(),
                session_id: session_id.clone(),
                error: Some(e.to_string()),
            },
        };
        let _ = app.emit("assistant://finished", finished);
    });

    Ok(())
}

/// Stop the assistant's currently-running agent, killing its process tree. The
/// in-flight turn then finishes with whatever it had streamed so far.
#[tauri::command]
pub async fn assistant_stop(state: tauri::State<'_, AppState>) -> Result<()> {
    let child = state.assistant_child.lock().unwrap().take();
    if let Some(mut child) = child {
        agent::kill_child(&mut child);
    }
    Ok(())
}

/// Generate (or update) a Playwright spec for a case with a coding agent. Runs
/// on a background thread, streaming `agent://*` events; the agent writes files
/// directly and TestHound reports which specs changed for the user to review
/// and accept. Never auto-commits or auto-links (docs/05 §5.1-5.3).
#[tauri::command]
pub fn generate_spec(
    case_id: String,
    agent_id: String,
    update: bool,
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<()> {
    let paths = state.paths()?;
    let kind = AgentKind::from_id(&agent_id)
        .ok_or_else(|| Error::Agent(format!("unknown agent: {agent_id}")))?;
    let case = repo::load_case(&paths, &case_id)?;
    let ctx = automation::detect_context(&paths, &case);
    let prompt = if update {
        automation::update_prompt(&case, &ctx)
    } else {
        automation::generate_prompt(&case, &ctx)
    };
    let kind_label = if update { "update" } else { "generate" };

    let _ = app.emit(
        "agent://started",
        AgentStartedEvent {
            id: case_id.clone(),
            kind: kind_label.to_string(),
        },
    );

    // Snapshot the specs on disk so we can report what the agent touched.
    let before = automation::snapshot_specs(&paths);

    std::thread::spawn(move || {
        let log_app = app.clone();
        let log_id = case_id.clone();
        let result = agent::run(&paths.root, kind, Mode::Edit, &prompt, |line| {
            let _ = log_app.emit(
                "agent://log",
                AgentLogEvent {
                    id: log_id.clone(),
                    line: line.to_string(),
                },
            );
        });

        let finished = match result {
            Ok(_) => {
                let changed = automation::changed_since(&paths, &before);
                AgentFinishedEvent {
                    id: case_id.clone(),
                    kind: kind_label.to_string(),
                    changed_specs: changed,
                    output: None,
                    error: None,
                }
            }
            Err(e) => AgentFinishedEvent {
                id: case_id.clone(),
                kind: kind_label.to_string(),
                changed_specs: vec![],
                output: None,
                error: Some(e.to_string()),
            },
        };
        let _ = app.emit("agent://finished", finished);
    });
    Ok(())
}

/// Agent-assisted failure triage for a failed automated result (docs/05 §5.6).
/// Read-only: the agent classifies and suggests; nothing is written or
/// committed. Streams `agent://*` events keyed by `<run_id>:<case_id>`.
#[tauri::command]
pub fn triage_failure(
    run_id: String,
    case_id: String,
    agent_id: String,
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<()> {
    let paths = state.paths()?;
    let kind = AgentKind::from_id(&agent_id)
        .ok_or_else(|| Error::Agent(format!("unknown agent: {agent_id}")))?;
    let detail = runs::load_run(&paths, &run_id)?;
    let error = detail
        .rows
        .iter()
        .find(|r| r.case == case_id)
        .and_then(|r| r.comment.clone())
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "No error message was recorded for this failure.".to_string());
    let case = repo::load_case(&paths, &case_id)?;
    let specs = case.front.automation.specs.clone();
    let prompt = automation::triage_prompt(&case, &error, &specs);
    let id = format!("{run_id}:{case_id}");

    let _ = app.emit(
        "agent://started",
        AgentStartedEvent {
            id: id.clone(),
            kind: "triage".to_string(),
        },
    );

    std::thread::spawn(move || {
        let log_app = app.clone();
        let log_id = id.clone();
        let result = agent::run(&paths.root, kind, Mode::ReadOnly, &prompt, |line| {
            let _ = log_app.emit(
                "agent://log",
                AgentLogEvent {
                    id: log_id.clone(),
                    line: line.to_string(),
                },
            );
        });
        let finished = match result {
            Ok(output) => AgentFinishedEvent {
                id: id.clone(),
                kind: "triage".to_string(),
                changed_specs: vec![],
                output: Some(output),
                error: None,
            },
            Err(e) => AgentFinishedEvent {
                id: id.clone(),
                kind: "triage".to_string(),
                changed_specs: vec![],
                output: None,
                error: Some(e.to_string()),
            },
        };
        let _ = app.emit("agent://finished", finished);
    });
    Ok(())
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
pub async fn dashboard(state: tauri::State<'_, AppState>) -> Result<Dashboard> {
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

// ---- Conflicts & semantic merge (docs/04-git-storage.md §4.6, roadmap M5) ------

/// All conflicts in the index, with a semantic field/step merge for each case
/// file and a plain list of the rest.
#[tauri::command]
pub async fn list_conflicts(state: tauri::State<'_, AppState>) -> Result<Conflicts> {
    let paths = state.paths()?;
    let repo = git::open(&paths.root)?;
    merge::conflicts(&repo)
}

/// Resolve a conflicted case file by picking a side per field. `picks` maps a
/// field key to `base`/`ours`/`theirs`; omitted fields use the suggested side.
#[tauri::command]
pub fn resolve_case_conflict(
    path: String,
    picks: std::collections::BTreeMap<String, Side>,
    state: tauri::State<AppState>,
) -> Result<TestCase> {
    merge::resolve_case(&state.paths()?, &path, &picks)
}

/// Resolve a modify/delete conflict by keeping the modified side.
#[tauri::command]
pub fn resolve_case_keep(
    path: String,
    keep: Side,
    state: tauri::State<AppState>,
) -> Result<TestCase> {
    merge::resolve_keep(&state.paths()?, &path, keep)
}

/// Resolve a modify/delete conflict by accepting the deletion.
#[tauri::command]
pub fn resolve_case_delete(path: String, state: tauri::State<AppState>) -> Result<()> {
    merge::resolve_delete(&state.paths()?, &path)
}

/// Case ids claimed by more than one file (a merge artifact when two branches
/// minted the same `TC-####`).
#[tauri::command]
pub async fn id_collisions(state: tauri::State<'_, AppState>) -> Result<Vec<IdCollision>> {
    merge::detect_id_collisions(&state.paths()?)
}

/// Renumber the case at `path` to a fresh id, relinking its references. Returns
/// the new id.
#[tauri::command]
pub async fn renumber_case(path: String, state: tauri::State<'_, AppState>) -> Result<String> {
    merge::renumber_case(&state.paths()?, &path)
}

// ---- Git LFS evidence (docs/04-git-storage.md §4.9) ---------------------------

#[tauri::command]
pub async fn lfs_status(state: tauri::State<'_, AppState>) -> Result<LfsStatus> {
    lfs::status(&state.paths()?)
}

#[tauri::command]
pub async fn enable_lfs(state: tauri::State<'_, AppState>) -> Result<LfsStatus> {
    lfs::enable(&state.paths()?)
}

#[tauri::command]
pub async fn disable_lfs(state: tauri::State<'_, AppState>) -> Result<LfsStatus> {
    lfs::disable(&state.paths()?)
}

// ---- Changes, commit & sync (docs/06-ui-ux.md frame 13, roadmap M6) -----------

/// Stage exactly the selected files and commit them with `message`. Returns the
/// refreshed status so the changes panel updates in place.
#[tauri::command]
pub async fn commit_changes(
    message: String,
    files: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<git::GitStatus> {
    let paths = state.paths()?;
    if message.trim().is_empty() {
        return Err(Error::Other("commit message is empty".into()));
    }
    git::commit_paths(&paths.root, message.trim(), &files)?;
    let repo = git::open(&paths.root)?;
    git::status(&repo)
}

/// Push the current branch to its upstream. Shells out to `git` so credential
/// helpers apply.
#[tauri::command]
pub async fn push_changes(state: tauri::State<'_, AppState>) -> Result<String> {
    git::push(&state.paths()?.root)
}

/// Fast-forward pull then push, for the repo-bar Sync button.
#[tauri::command]
pub async fn sync_repo(state: tauri::State<'_, AppState>) -> Result<String> {
    git::sync(&state.paths()?.root)
}

// ---- Case history & diff (docs/06-ui-ux.md frame 05, roadmap M6) --------------

/// Resolve a case id to its repo-relative file path.
fn case_path(paths: &Paths, id: &str) -> Result<String> {
    repo::list_cases(paths)?
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.path)
        .ok_or_else(|| Error::CaseNotFound(id.to_string()))
}

/// The commit timeline for a case file (newest first).
#[tauri::command]
pub async fn case_history(id: String, state: tauri::State<'_, AppState>) -> Result<Vec<git::CommitInfo>> {
    let paths = state.paths()?;
    let rel = case_path(&paths, &id)?;
    let repo = git::open(&paths.root)?;
    git::log_for_path(&repo, &rel, 100)
}

/// A case file's diff for one commit: its contents there and at the prior
/// commit, plus whether the change touched step expectations and so would drift
/// a linked spec.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseCommitDiff {
    pub path: String,
    pub old: Option<String>,
    pub new_content: String,
    pub is_new: bool,
    pub commit: git::CommitInfo,
    /// The commit changed steps/expectations and the case has a linked spec, so
    /// the spec is (or would be) marked drifted.
    pub affects_spec: bool,
}

/// Lines that define behaviour: numbered steps and their expectations. Used to
/// decide whether a commit's edit would drift the linked Playwright spec.
fn behaviour_lines(s: &str) -> Vec<String> {
    s.lines()
        .map(str::trim)
        .filter(|l| {
            let lower = l.to_lowercase();
            lower.contains("expected")
                || l.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        })
        .map(|l| l.to_string())
        .collect()
}

#[tauri::command]
pub async fn case_commit_diff(
    id: String,
    hash: String,
    state: tauri::State<'_, AppState>,
) -> Result<CaseCommitDiff> {
    let paths = state.paths()?;
    let rel = case_path(&paths, &id)?;
    let repo = git::open(&paths.root)?;
    let old = git::file_before_commit(&repo, &rel, &hash)?;
    let new_content = git::file_at_commit(&repo, &rel, &hash)?.unwrap_or_default();

    let steps_changed = match &old {
        Some(o) => behaviour_lines(o) != behaviour_lines(&new_content),
        None => false,
    };
    let has_spec = !repo::load_case(&paths, &id)
        .map(|c| c.front.automation.specs)
        .unwrap_or_default()
        .is_empty();

    Ok(CaseCommitDiff {
        is_new: old.is_none(),
        old,
        commit: git::commit_meta(&repo, &hash)?,
        path: rel,
        new_content,
        affects_spec: steps_changed && has_spec,
    })
}

/// Per-line blame for a case's working-tree version.
#[tauri::command]
pub async fn case_blame(id: String, state: tauri::State<'_, AppState>) -> Result<Vec<git::BlameLine>> {
    let paths = state.paths()?;
    let rel = case_path(&paths, &id)?;
    let repo = git::open(&paths.root)?;
    git::blame_file(&repo, &rel)
}

/// Restore a case file to its contents at `hash`, leaving the change unstaged in
/// the working tree for review. Returns the reloaded case.
#[tauri::command]
pub async fn restore_case_version(
    id: String,
    hash: String,
    state: tauri::State<'_, AppState>,
) -> Result<TestCase> {
    let paths = state.paths()?;
    let rel = case_path(&paths, &id)?;
    let repo = git::open(&paths.root)?;
    let content = git::file_at_commit(&repo, &rel, &hash)?
        .ok_or_else(|| Error::Other("file did not exist at that commit".into()))?;
    std::fs::write(paths.root.join(&rel), content)?;
    repo::load_case(&paths, &id)
}

// ---- Auto-update (roadmap M5) -------------------------------------------------

/// The result of checking the signed release feed for a newer version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    /// Set when the updater isn't configured or the network check failed, so
    /// the UI can explain rather than silently show "up to date".
    pub error: Option<String>,
}

/// Query the updater endpoint for a newer, signed release. Never errors out to
/// the UI: a missing config or offline check comes back as `error` so the
/// Settings screen can render it calmly.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo> {
    use tauri_plugin_updater::UpdaterExt;
    let current = app.package_info().version.to_string();
    let mut info = UpdateInfo {
        available: false,
        current_version: current,
        version: None,
        notes: None,
        error: None,
    };
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            info.error = Some(format!("updater not configured: {e}"));
            return Ok(info);
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            info.available = true;
            info.version = Some(update.version.clone());
            info.notes = update.body.clone();
        }
        Ok(None) => {}
        Err(e) => info.error = Some(e.to_string()),
    }
    Ok(info)
}

/// Download and install the pending update. The caller restarts the app to
/// apply it.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<()> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|e| Error::Other(format!("updater not configured: {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|e| Error::Other(e.to_string()))?
        .ok_or_else(|| Error::Other("no update available".into()))?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| Error::Other(e.to_string()))?;
    Ok(())
}
