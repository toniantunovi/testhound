//! On-disk format for runs, results, milestones, and configurations, plus the
//! include-resolution and filter-query engine that turns a run definition into
//! a stable set of member cases (docs/03-data-model.md §3.4).
//!
//! A run's membership is a *snapshot*: the filter/suite selection is resolved
//! to explicit case ids at creation time and stored in `run.yml`, so the run
//! stays reproducible even as the case corpus changes underneath it. Results
//! live one-file-per-case under `results/`; the absence of a file means the
//! case is still `untested`.

use super::{CaseSummary, Paths};
use crate::domain::{
    AutomationState, Configuration, IncludeMode, Includes, Milestone, Priority, ResultHistoryEntry,
    ResultSource, ResultStatus, Run, RunResult, RunState,
};
use crate::error::{Error, Result};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

// ---- paths --------------------------------------------------------------------

fn runs_dir(paths: &Paths) -> PathBuf {
    paths.th.join("runs")
}
fn run_dir(paths: &Paths, id: &str) -> PathBuf {
    runs_dir(paths).join(id)
}
fn results_dir(paths: &Paths, id: &str) -> PathBuf {
    run_dir(paths, id).join("results")
}
fn milestones_dir(paths: &Paths) -> PathBuf {
    paths.th.join("milestones")
}
fn configurations_dir(paths: &Paths) -> PathBuf {
    paths.th.join("configurations")
}

/// Current UTC timestamp in the `2026-07-09T09:14:03Z` style used on disk.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---- DTOs sent to the frontend (camelCase) -----------------------------------

/// Aggregate status counts for a run, used for progress bars and dashboards.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProgress {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub blocked: usize,
    pub retest: usize,
    pub skipped: usize,
    pub untested: usize,
}

impl RunProgress {
    fn add(&mut self, status: ResultStatus) {
        self.total += 1;
        match status {
            ResultStatus::Passed => self.passed += 1,
            ResultStatus::Failed => self.failed += 1,
            ResultStatus::Blocked => self.blocked += 1,
            ResultStatus::Retest => self.retest += 1,
            ResultStatus::Skipped => self.skipped += 1,
            ResultStatus::Untested => self.untested += 1,
        }
    }

    /// Pass rate over *executed* cases (untested excluded). Zero when nothing
    /// has run yet.
    pub fn pass_rate(&self) -> u32 {
        let executed = self.total - self.untested;
        if executed == 0 {
            0
        } else {
            ((self.passed as f64 / executed as f64) * 100.0).round() as u32
        }
    }
}

/// A run row for the list view, with computed progress.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub name: String,
    pub milestone: Option<String>,
    pub configuration: Vec<String>,
    pub assignee: Option<String>,
    pub state: RunState,
    pub created: Option<String>,
    pub progress: RunProgress,
}

/// One case's row inside a run's execution view: case metadata joined with its
/// recorded result (or the untested default).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResultRow {
    pub case: String,
    pub title: String,
    pub suite: String,
    pub section: Option<String>,
    pub priority: Priority,
    pub automation_state: AutomationState,
    pub status: ResultStatus,
    pub source: ResultSource,
    pub comment: Option<String>,
    pub executed_by: Option<String>,
    pub executed_at: Option<String>,
    pub elapsed: Option<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    pub attempts: usize,
}

/// A full run for the execution view: definition + rows + progress.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: Run,
    pub rows: Vec<RunResultRow>,
    pub progress: RunProgress,
}

/// Inputs for creating a run. Membership is resolved from `mode` + the relevant
/// field (`cases` / `suites` / `query`).
#[derive(Debug, Clone)]
pub struct CreateRun {
    pub name: String,
    pub milestone: Option<String>,
    pub configuration: Vec<String>,
    pub description: Option<String>,
    pub assignee: Option<String>,
    pub mode: IncludeMode,
    pub query: Option<String>,
    pub suites: Vec<String>,
    pub cases: Vec<String>,
}

// ---- include resolution / filter query ---------------------------------------

/// Resolve a run definition to a sorted, de-duplicated set of member case ids.
pub fn resolve_includes(
    all: &[CaseSummary],
    mode: IncludeMode,
    query: Option<&str>,
    suites: &[String],
    cases: &[String],
) -> Vec<String> {
    let mut ids: Vec<String> = match mode {
        IncludeMode::Explicit => {
            let want: std::collections::HashSet<&str> = cases.iter().map(String::as_str).collect();
            all.iter()
                .filter(|c| want.contains(c.id.as_str()))
                .map(|c| c.id.clone())
                .collect()
        }
        IncludeMode::Suite => all
            .iter()
            .filter(|c| suites.iter().any(|s| s == &c.suite))
            .map(|c| c.id.clone())
            .collect(),
        IncludeMode::Filter => all
            .iter()
            .filter(|c| matches_query(c, query.unwrap_or("")))
            .map(|c| c.id.clone())
            .collect(),
    };
    ids.sort();
    ids.dedup();
    ids
}

/// Serialize a unit enum to its on-disk string (e.g. `Priority::High` -> "high").
fn enum_str<T: Serialize>(v: &T) -> String {
    serde_yaml::to_value(v)
        .ok()
        .and_then(|x| x.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Evaluate a filter query against a case. The language is a disjunction of
/// AND-groups: `suite:checkout AND tag:p1 OR tag:smoke`. Bare terms match the
/// id, title, or tags. `OR`/`AND` are case-insensitive keywords; an empty query
/// matches everything.
pub fn matches_query(c: &CaseSummary, query: &str) -> bool {
    let q = query.trim();
    if q.is_empty() {
        return true;
    }
    let mut group_ok = true; // AND accumulator for the current OR-group
    let mut group_has_term = false;
    let mut any_group = false;

    for token in q.split_whitespace() {
        match token.to_ascii_uppercase().as_str() {
            "OR" => {
                if group_has_term && group_ok {
                    any_group = true;
                }
                group_ok = true;
                group_has_term = false;
            }
            "AND" => {} // implicit within a group
            term => {
                group_has_term = true;
                group_ok = group_ok && term_matches(c, term);
            }
        }
    }
    if group_has_term && group_ok {
        any_group = true;
    }
    any_group
}

fn term_matches(c: &CaseSummary, term: &str) -> bool {
    if let Some((key, value)) = term.split_once(':') {
        let value = value.trim().to_ascii_lowercase();
        match key.trim().to_ascii_lowercase().as_str() {
            "suite" => c.suite.eq_ignore_ascii_case(&value),
            "section" => c
                .section
                .as_deref()
                .map(|s| s.eq_ignore_ascii_case(&value))
                .unwrap_or(false),
            "tag" => c.tags.iter().any(|t| t.eq_ignore_ascii_case(&value)),
            "priority" => enum_str(&c.priority) == value,
            "type" => enum_str(&c.kind) == value,
            "status" => enum_str(&c.status) == value,
            "owner" => c
                .owner
                .as_deref()
                .map(|o| o.eq_ignore_ascii_case(&value))
                .unwrap_or(false),
            "automation" => enum_str(&c.automation_state) == value,
            _ => false,
        }
    } else {
        let needle = term.to_ascii_lowercase();
        c.title.to_ascii_lowercase().contains(&needle)
            || c.id.to_ascii_lowercase().contains(&needle)
            || c.tags.iter().any(|t| t.to_ascii_lowercase().contains(&needle))
    }
}

// ---- reading ------------------------------------------------------------------

fn load_run_meta(paths: &Paths, id: &str) -> Result<Run> {
    let path = run_dir(paths, id).join("run.yml");
    let content = fs::read_to_string(&path).map_err(|_| Error::RunNotFound(id.to_string()))?;
    Ok(serde_yaml::from_str(&content)?)
}

fn read_results(paths: &Paths, id: &str) -> Result<BTreeMap<String, RunResult>> {
    let dir = results_dir(paths, id);
    let mut map = BTreeMap::new();
    if !dir.is_dir() {
        return Ok(map);
    }
    for entry in fs::read_dir(&dir)? {
        let p = entry?.path();
        if p.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        if let Ok(result) = serde_yaml::from_str::<RunResult>(&fs::read_to_string(&p)?) {
            map.insert(result.case.clone(), result);
        }
    }
    Ok(map)
}

fn progress_for(paths: &Paths, run: &Run) -> Result<RunProgress> {
    let results = read_results(paths, &run.id)?;
    let mut progress = RunProgress::default();
    for case in &run.includes.cases {
        let status = results
            .get(case)
            .map(|r| r.status)
            .unwrap_or(ResultStatus::Untested);
        progress.add(status);
    }
    Ok(progress)
}

/// List runs newest-first, each with computed progress.
pub fn list_runs(paths: &Paths) -> Result<Vec<RunSummary>> {
    let dir = runs_dir(paths);
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(&dir)? {
        let p = entry?.path();
        if !p.is_dir() || !p.join("run.yml").is_file() {
            continue;
        }
        let run: Run = serde_yaml::from_str(&fs::read_to_string(p.join("run.yml"))?)?;
        let progress = progress_for(paths, &run)?;
        out.push(RunSummary {
            id: run.id,
            name: run.name,
            milestone: run.milestone,
            configuration: run.configuration,
            assignee: run.assignee,
            state: run.state,
            created: run.created,
            progress,
        });
    }
    // Newest first: by created desc, then id desc as a stable tiebreak.
    out.sort_by(|a, b| b.created.cmp(&a.created).then(b.id.cmp(&a.id)));
    Ok(out)
}

/// Load a run with its per-case rows (case metadata joined to results).
pub fn load_run(paths: &Paths, id: &str) -> Result<RunDetail> {
    let run = load_run_meta(paths, id)?;
    let by_id: BTreeMap<String, CaseSummary> = super::list_cases(paths)?
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();
    let results = read_results(paths, id)?;

    let mut rows = Vec::with_capacity(run.includes.cases.len());
    let mut progress = RunProgress::default();
    for cid in &run.includes.cases {
        let meta = by_id.get(cid);
        let res = results.get(cid);
        let status = res.map(|r| r.status).unwrap_or(ResultStatus::Untested);
        progress.add(status);
        rows.push(RunResultRow {
            case: cid.clone(),
            title: meta.map(|m| m.title.clone()).unwrap_or_else(|| cid.clone()),
            suite: meta.map(|m| m.suite.clone()).unwrap_or_default(),
            section: meta.and_then(|m| m.section.clone()),
            priority: meta.map(|m| m.priority).unwrap_or_default(),
            automation_state: meta.map(|m| m.automation_state).unwrap_or_default(),
            status,
            source: res.map(|r| r.source).unwrap_or_default(),
            comment: res.and_then(|r| r.comment.clone()),
            executed_by: res.and_then(|r| r.executed_by.clone()),
            executed_at: res.and_then(|r| r.executed_at.clone()),
            elapsed: res.and_then(|r| r.elapsed.clone()),
            evidence: res.map(|r| r.evidence.clone()).unwrap_or_default(),
            attempts: res.map(|r| r.history.len()).unwrap_or(0),
        });
    }
    Ok(RunDetail {
        run,
        rows,
        progress,
    })
}

// ---- writing ------------------------------------------------------------------

fn write_run(paths: &Paths, run: &Run) -> Result<()> {
    fs::create_dir_all(results_dir(paths, &run.id))?;
    fs::write(
        run_dir(paths, &run.id).join("run.yml"),
        serde_yaml::to_string(run)?,
    )?;
    Ok(())
}

/// Allocate a unique `<date>-<slug>` run id, disambiguating collisions with a
/// numeric suffix.
fn unique_run_id(paths: &Paths, date: &str, name: &str) -> String {
    let slug = slug::slugify(name);
    let base = if slug.is_empty() {
        format!("{date}-run")
    } else {
        format!("{date}-{slug}")
    };
    if !run_dir(paths, &base).exists() {
        return base;
    }
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if !run_dir(paths, &candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Create a run: resolve its membership snapshot and write `run.yml`.
pub fn create_run(paths: &Paths, input: CreateRun) -> Result<Run> {
    let all = super::list_cases(paths)?;
    let cases = resolve_includes(
        &all,
        input.mode,
        input.query.as_deref(),
        &input.suites,
        &input.cases,
    );
    let created = now_iso();
    let date = &created[..10];
    let id = unique_run_id(paths, date, &input.name);
    let run = Run {
        id,
        name: input.name,
        milestone: input.milestone,
        configuration: input.configuration,
        description: input.description,
        includes: Includes {
            mode: input.mode,
            query: input.query,
            suites: input.suites,
            cases,
        },
        assignee: input.assignee,
        state: RunState::Planned,
        created: Some(created),
        updated: None,
    };
    write_run(paths, &run)?;
    Ok(run)
}

/// One result update. `comment`/`elapsed` are `None` to leave the existing
/// value, `Some` to set it (an empty comment clears it); `evidence` is `None`
/// to leave artifacts untouched or `Some` to replace them (a re-run overwrites
/// the prior run's artifacts).
#[derive(Debug, Clone)]
pub struct ResultInput {
    pub status: ResultStatus,
    pub source: ResultSource,
    pub executed_by: Option<String>,
    pub comment: Option<String>,
    pub elapsed: Option<String>,
    pub evidence: Option<Vec<String>>,
}

/// Record (or overwrite) a case's result within a run, appending to its
/// history. Recording the first result advances a `planned` run to
/// `in_progress`. Shared by manual recording and automated ingestion.
pub fn apply_result(
    paths: &Paths,
    run_id: &str,
    case_id: &str,
    input: ResultInput,
) -> Result<RunResult> {
    let mut run = load_run_meta(paths, run_id)?;
    if !run.includes.cases.iter().any(|c| c == case_id) {
        return Err(Error::CaseNotFound(format!(
            "{case_id} is not a member of run {run_id}"
        )));
    }

    let dir = results_dir(paths, run_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{case_id}.yml"));

    let mut result = if path.is_file() {
        serde_yaml::from_str::<RunResult>(&fs::read_to_string(&path)?)?
    } else {
        RunResult {
            case: case_id.to_string(),
            status: ResultStatus::Untested,
            executed_by: None,
            executed_at: None,
            source: ResultSource::Manual,
            elapsed: None,
            comment: None,
            evidence: Vec::new(),
            defects: Vec::new(),
            history: Vec::new(),
        }
    };

    let now = now_iso();
    result.status = input.status;
    result.source = input.source;
    result.executed_by = input.executed_by.clone();
    result.executed_at = Some(now.clone());
    if let Some(c) = input.comment {
        result.comment = if c.trim().is_empty() { None } else { Some(c) };
    }
    if let Some(e) = input.elapsed {
        result.elapsed = Some(e);
    }
    if let Some(ev) = input.evidence {
        result.evidence = ev;
    }
    result.history.push(ResultHistoryEntry {
        at: now,
        status: input.status,
        by: input.executed_by,
    });

    fs::write(&path, serde_yaml::to_string(&result)?)?;

    if run.state == RunState::Planned {
        run.state = RunState::InProgress;
        run.updated = Some(now_iso());
        write_run(paths, &run)?;
    }
    Ok(result)
}

/// Record a manual result. Passing `comment: Some("")` clears the comment;
/// `None` leaves it. Thin wrapper over [`apply_result`].
pub fn set_result(
    paths: &Paths,
    run_id: &str,
    case_id: &str,
    status: ResultStatus,
    comment: Option<String>,
    executed_by: Option<String>,
    source: ResultSource,
) -> Result<RunResult> {
    apply_result(
        paths,
        run_id,
        case_id,
        ResultInput {
            status,
            source,
            executed_by,
            comment,
            elapsed: None,
            evidence: None,
        },
    )
}

/// Update a run's lifecycle state.
pub fn set_run_state(paths: &Paths, run_id: &str, state: RunState) -> Result<Run> {
    let mut run = load_run_meta(paths, run_id)?;
    run.state = state;
    run.updated = Some(now_iso());
    write_run(paths, &run)?;
    Ok(run)
}

// ---- milestones & configurations ---------------------------------------------

fn list_yaml<T: serde::de::DeserializeOwned>(dir: PathBuf) -> Result<Vec<T>> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(&dir)? {
        let p = entry?.path();
        if p.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        if let Ok(v) = serde_yaml::from_str::<T>(&fs::read_to_string(&p)?) {
            out.push(v);
        }
    }
    Ok(out)
}

pub fn list_milestones(paths: &Paths) -> Result<Vec<Milestone>> {
    let mut ms: Vec<Milestone> = list_yaml(milestones_dir(paths))?;
    ms.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ms)
}

pub fn list_configurations(paths: &Paths) -> Result<Vec<Configuration>> {
    let mut cfgs: Vec<Configuration> = list_yaml(configurations_dir(paths))?;
    cfgs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(cfgs)
}

pub fn write_milestone(paths: &Paths, m: &Milestone) -> Result<()> {
    let dir = milestones_dir(paths);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(format!("{}.yml", m.id)), serde_yaml::to_string(m)?)?;
    Ok(())
}

pub fn write_configuration(paths: &Paths, c: &Configuration) -> Result<()> {
    let dir = configurations_dir(paths);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(format!("{}.yml", c.id)), serde_yaml::to_string(c)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CaseStatus, CaseType};

    fn case(id: &str, suite: &str, tags: &[&str], priority: Priority, kind: CaseType) -> CaseSummary {
        CaseSummary {
            id: id.into(),
            title: format!("Case {id}"),
            suite: suite.into(),
            section: None,
            priority,
            kind,
            status: CaseStatus::Active,
            owner: None,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            automation_state: AutomationState::None,
            updated: None,
            path: format!("suites/{suite}/cases/{id}.md"),
            broken: false,
        }
    }

    fn corpus() -> Vec<CaseSummary> {
        vec![
            case("TC-0001", "auth", &["p1", "smoke"], Priority::Critical, CaseType::Smoke),
            case("TC-0007", "checkout", &["cart", "p1"], Priority::High, CaseType::Functional),
            case("TC-0010", "checkout", &["cart"], Priority::Medium, CaseType::E2e),
            case("TC-0021", "search", &["p1"], Priority::High, CaseType::Functional),
        ]
    }

    fn ids(cases: &[CaseSummary], query: &str) -> Vec<String> {
        cases
            .iter()
            .filter(|c| matches_query(c, query))
            .map(|c| c.id.clone())
            .collect()
    }

    #[test]
    fn empty_query_matches_all() {
        let c = corpus();
        assert_eq!(ids(&c, "").len(), 4);
        assert_eq!(ids(&c, "   ").len(), 4);
    }

    #[test]
    fn or_unions_groups() {
        let c = corpus();
        let got = ids(&c, "suite:checkout OR tag:p1");
        assert!(got.contains(&"TC-0001".to_string())); // p1
        assert!(got.contains(&"TC-0007".to_string())); // checkout + p1
        assert!(got.contains(&"TC-0010".to_string())); // checkout
        assert!(got.contains(&"TC-0021".to_string())); // p1
        assert_eq!(got.len(), 4);
    }

    #[test]
    fn and_intersects_within_group() {
        let c = corpus();
        let got = ids(&c, "suite:checkout AND tag:p1");
        assert_eq!(got, vec!["TC-0007".to_string()]);
    }

    #[test]
    fn typed_terms_and_free_text() {
        let c = corpus();
        assert_eq!(ids(&c, "priority:critical"), vec!["TC-0001".to_string()]);
        assert_eq!(ids(&c, "type:e2e"), vec!["TC-0010".to_string()]);
        // Free text hits id/title/tags.
        assert_eq!(ids(&c, "TC-0021"), vec!["TC-0021".to_string()]);
    }

    #[test]
    fn resolve_modes() {
        let c = corpus();
        let suite = resolve_includes(&c, IncludeMode::Suite, None, &["checkout".into()], &[]);
        assert_eq!(suite, vec!["TC-0007".to_string(), "TC-0010".to_string()]);

        let explicit = resolve_includes(
            &c,
            IncludeMode::Explicit,
            None,
            &[],
            &["TC-0021".into(), "TC-0001".into(), "TC-9999".into()],
        );
        // Sorted, and the unknown id is dropped.
        assert_eq!(explicit, vec!["TC-0001".to_string(), "TC-0021".to_string()]);
    }

    #[test]
    fn pass_rate_excludes_untested() {
        let mut p = RunProgress::default();
        p.add(ResultStatus::Passed);
        p.add(ResultStatus::Passed);
        p.add(ResultStatus::Failed);
        p.add(ResultStatus::Untested);
        assert_eq!(p.total, 4);
        assert_eq!(p.pass_rate(), 67); // 2 of 3 executed
    }
}
