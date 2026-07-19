//! Playwright execution (docs/05-ai-automation.md §5.4-5.5, roadmap M3).
//!
//! The heavy logic here is pure and unit-testable: turning a run's member cases
//! into a *plan* (which spec files and test titles to run), parsing Playwright's
//! JSON report, and *ingesting* the reported tests back into the run's results
//! as `source: automated`. The only side-effecting parts are [`execute`] (which
//! spawns `npx playwright test`) and [`show_trace`]; everything they rely on is
//! testable without a live Playwright install by feeding a synthetic report to
//! [`parse_report`] + [`ingest`].

use crate::domain::{ResultSource, ResultStatus, Run};
use crate::error::{Error, Result};
use crate::repo::runs::{self, ResultInput};
use crate::repo::Paths;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ---- detection ----------------------------------------------------------------

/// What we could learn about the project's Playwright install, cheaply and
/// without spawning anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaywrightInfo {
    pub detected: bool,
    /// The config file that was found, repo-relative, if any.
    pub config: Option<String>,
    /// Whether a local `node_modules/.bin/playwright` exists (preferred runner).
    pub local_binary: bool,
}

const CONFIGS: [&str; 4] = [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs",
    "playwright.config.cts",
];

pub fn detect(repo_root: &Path) -> PlaywrightInfo {
    let config = CONFIGS
        .iter()
        .find(|f| repo_root.join(f).is_file())
        .map(|f| f.to_string());
    PlaywrightInfo {
        detected: config.is_some(),
        config,
        local_binary: local_binary(repo_root).is_some(),
    }
}

// ---- test target (where runs point) -------------------------------------------

/// Per-developer configuration of where Playwright runs are directed: the base
/// URL/host and any extra environment variables. Stored under the gitignored
/// `.testhound/` cache so it stays local (it may point at a personal
/// environment or hold secrets) rather than being committed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
}

fn target_path(paths: &Paths) -> PathBuf {
    paths.th.join(".testhound").join("target.yml")
}

/// Load the configured test target, or defaults if none has been saved.
pub fn load_target(paths: &Paths) -> TestTarget {
    let path = target_path(paths);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_yaml::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist the test target to the local (gitignored) cache.
pub fn save_target(paths: &Paths, target: &TestTarget) -> Result<()> {
    let path = target_path(paths);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_yaml::to_string(target)?)?;
    Ok(())
}

/// The environment variables a target contributes to a Playwright run. The base
/// URL is exposed under the common names a `playwright.config` might read
/// (`process.env.BASE_URL` etc.); custom vars are passed through verbatim.
pub fn target_env(target: &TestTarget) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(url) = target.base_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        for key in ["BASE_URL", "PLAYWRIGHT_TEST_BASE_URL", "PLAYWRIGHT_BASE_URL"] {
            env.push((key.to_string(), url.to_string()));
        }
    }
    for (k, v) in &target.env {
        env.push((k.clone(), v.clone()));
    }
    env
}

/// Best-effort scrape of `testDir: "…"` from a Playwright config, normalized to
/// a repo-relative directory (no leading `./`, no trailing slash).
pub fn detect_test_dir(config: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config).ok()?;
    let idx = text.find("testDir")?;
    let after = &text[idx + "testDir".len()..];
    let after = after.trim_start_matches([':', ' ', '\t']);
    let quote = after.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let rest = &after[1..];
    let end = rest.find(quote)?;
    let dir = rest[..end]
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/');
    (!dir.is_empty()).then(|| dir.to_string())
}

/// Verify every spec file exists and is discoverable by Playwright (i.e. lives
/// inside the configured `testDir`). Playwright's own failure mode for both is
/// a bare "No tests found", which explains nothing; this turns it into an
/// actionable error before anything is spawned.
fn validate_spec_files<'a, I: IntoIterator<Item = &'a String>>(
    paths: &Paths,
    info: &PlaywrightInfo,
    files: I,
) -> Result<()> {
    let test_dir = info
        .config
        .as_deref()
        .and_then(|cfg| detect_test_dir(&paths.root.join(cfg)));
    for f in files {
        if !paths.root.join(f).is_file() {
            return Err(Error::Playwright(format!(
                "linked spec not found on disk: {f} (relink the case or regenerate its automation)"
            )));
        }
        if let Some(dir) = &test_dir {
            if f != dir && !f.starts_with(&format!("{dir}/")) {
                return Err(Error::Playwright(format!(
                    "spec {f} is outside Playwright's testDir ({dir}/), so Playwright will not \
                     discover it; move the file under {dir}/ and update the case's linked spec path"
                )));
            }
        }
    }
    Ok(())
}

fn local_binary(repo_root: &Path) -> Option<PathBuf> {
    let bin = repo_root.join("node_modules").join(".bin").join("playwright");
    bin.is_file().then_some(bin)
}

/// Resolve the runner: prefer the project's local binary, else fall back to
/// `npx playwright`. Returns `(program, leading_args)`.
fn runner(repo_root: &Path) -> (String, Vec<String>) {
    match local_binary(repo_root) {
        Some(bin) => (bin.display().to_string(), vec![]),
        None => ("npx".to_string(), vec!["playwright".to_string()]),
    }
}

// ---- spec references ----------------------------------------------------------

/// A parsed automation spec reference: `tests/foo.spec.ts#test title`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecRef {
    pub file: String,
    pub test: Option<String>,
}

/// Split a `path#test title` reference. Everything before the first `#` is the
/// file; the remainder (if any) is the exact test title.
pub fn parse_spec_ref(s: &str) -> SpecRef {
    match s.split_once('#') {
        Some((file, test)) => SpecRef {
            file: normalize_path(file.trim()),
            test: {
                let t = test.trim();
                (!t.is_empty()).then(|| t.to_string())
            },
        },
        None => SpecRef {
            file: normalize_path(s.trim()),
            test: None,
        },
    }
}

/// Normalize a path for comparison: forward slashes, no leading `./`.
fn normalize_path(p: &str) -> String {
    let p = p.replace('\\', "/");
    p.strip_prefix("./").unwrap_or(&p).to_string()
}

/// Do two spec paths refer to the same file? Playwright may report a file
/// relative to a different root than the case's stored path, so we accept a
/// suffix match on either side.
fn file_matches(a: &str, b: &str) -> bool {
    let (a, b) = (normalize_path(a), normalize_path(b));
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

// ---- planning -----------------------------------------------------------------

/// The linkage we need from one member case to plan its execution.
#[derive(Debug, Clone)]
pub struct CaseLink {
    pub id: String,
    pub title: String,
    /// Raw `automation.specs` entries from the case front matter.
    pub specs: Vec<String>,
}

/// A member case that has at least one linked spec, resolved for execution.
#[derive(Debug, Clone)]
pub struct PlannedCase {
    pub case: String,
    pub title: String,
    /// Distinct spec files this case links to.
    pub files: Vec<String>,
    /// Explicit `(file, test)` pairs from refs that named a test.
    pub explicit_tests: Vec<(String, String)>,
}

/// The resolved execution plan for a run.
#[derive(Debug, Clone)]
pub struct RunPlan {
    pub cases: Vec<PlannedCase>,
    /// Member case ids with no linked spec (cannot be automated).
    pub skipped: Vec<String>,
    /// De-duplicated spec files to pass to Playwright.
    pub files: Vec<String>,
    /// Test titles to `--grep` (case titles + explicitly named tests).
    pub greps: Vec<String>,
}

/// Build the execution plan from the run's member cases.
pub fn plan(members: &[CaseLink]) -> RunPlan {
    let mut cases = Vec::new();
    let mut skipped = Vec::new();
    let mut files: BTreeSet<String> = BTreeSet::new();
    let mut greps: BTreeSet<String> = BTreeSet::new();

    for m in members {
        let refs: Vec<SpecRef> = m.specs.iter().map(|s| parse_spec_ref(s)).collect();
        if refs.is_empty() {
            skipped.push(m.id.clone());
            continue;
        }
        let mut case_files: Vec<String> = Vec::new();
        let mut explicit = Vec::new();
        for r in &refs {
            if !case_files.contains(&r.file) {
                case_files.push(r.file.clone());
            }
            files.insert(r.file.clone());
            if let Some(t) = &r.test {
                explicit.push((r.file.clone(), t.clone()));
                greps.insert(t.clone());
            }
        }
        // The documented convention is one test() titled exactly as the case,
        // so grep on the case title too (covers file-only refs).
        greps.insert(m.title.clone());
        cases.push(PlannedCase {
            case: m.id.clone(),
            title: m.title.clone(),
            files: case_files,
            explicit_tests: explicit,
        });
    }

    RunPlan {
        cases,
        skipped,
        files: files.into_iter().collect(),
        greps: greps.into_iter().collect(),
    }
}

// ---- JSON report parsing ------------------------------------------------------

/// One test, flattened out of the nested report, ready to map to a case.
#[derive(Debug, Clone)]
pub struct ReportedTest {
    pub file: String,
    pub title: String,
    pub status: ResultStatus,
    pub duration_ms: f64,
    pub attachments: Vec<String>,
    /// First error message (failures only), first line, for a result comment.
    pub message: Option<String>,
}

#[derive(Deserialize)]
struct RawReport {
    #[serde(default)]
    suites: Vec<RawSuite>,
}

#[derive(Deserialize)]
struct RawSuite {
    #[serde(default)]
    file: String,
    #[serde(default)]
    specs: Vec<RawSpec>,
    #[serde(default)]
    suites: Vec<RawSuite>,
}

#[derive(Deserialize)]
struct RawSpec {
    #[serde(default)]
    title: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    tests: Vec<RawTest>,
}

#[derive(Deserialize)]
struct RawTest {
    #[serde(default)]
    status: String,
    #[serde(default)]
    results: Vec<RawResult>,
}

#[derive(Deserialize)]
struct RawResult {
    #[serde(default)]
    status: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    attachments: Vec<RawAttachment>,
    #[serde(default)]
    errors: Vec<RawError>,
    #[serde(default)]
    error: Option<RawError>,
}

#[derive(Deserialize)]
struct RawAttachment {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
struct RawError {
    #[serde(default)]
    message: Option<String>,
}

/// Parse a Playwright JSON report into a flat list of reported tests.
pub fn parse_report(json: &str) -> Result<Vec<ReportedTest>> {
    let report: RawReport =
        serde_json::from_str(json).map_err(|e| Error::Playwright(format!("bad report: {e}")))?;
    let mut out = Vec::new();
    for s in &report.suites {
        walk_suite(s, "", &mut out);
    }
    Ok(out)
}

fn walk_suite(s: &RawSuite, inherited_file: &str, out: &mut Vec<ReportedTest>) {
    let file = if s.file.is_empty() {
        inherited_file
    } else {
        &s.file
    };
    for spec in &s.specs {
        let spec_file = if spec.file.is_empty() { file } else { &spec.file };
        if let Some(rt) = flatten_spec(spec, spec_file) {
            out.push(rt);
        }
    }
    for child in &s.suites {
        walk_suite(child, file, out);
    }
}

fn flatten_spec(spec: &RawSpec, file: &str) -> Option<ReportedTest> {
    let test = spec.tests.first()?;
    let last = test.results.last();
    let status = map_status(&test.status, last.map(|r| r.status.as_str()));
    let duration_ms = last.map(|r| r.duration).unwrap_or(0.0);
    let attachments = last
        .map(|r| {
            r.attachments
                .iter()
                .filter_map(|a| a.path.clone())
                .collect()
        })
        .unwrap_or_default();
    let message = if status == ResultStatus::Failed {
        last.and_then(first_message)
    } else {
        None
    };
    Some(ReportedTest {
        file: normalize_path(file),
        title: spec.title.clone(),
        status,
        duration_ms,
        attachments,
        message,
    })
}

fn first_message(r: &RawResult) -> Option<String> {
    let raw = r
        .errors
        .first()
        .and_then(|e| e.message.clone())
        .or_else(|| r.error.as_ref().and_then(|e| e.message.clone()))?;
    // Strip ANSI escapes and keep the first non-empty line, trimmed.
    let clean = strip_ansi(&raw);
    let line = clean.lines().find(|l| !l.trim().is_empty())?.trim();
    let line = if line.chars().count() > 200 {
        format!("{}…", line.chars().take(199).collect::<String>())
    } else {
        line.to_string()
    };
    Some(line)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // Skip until the terminating letter of the escape sequence.
            for e in chars.by_ref() {
                if e.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Map Playwright's test/result status strings to our `ResultStatus`.
fn map_status(test_status: &str, result_status: Option<&str>) -> ResultStatus {
    match test_status {
        "expected" | "flaky" => ResultStatus::Passed,
        "skipped" => ResultStatus::Skipped,
        "unexpected" => ResultStatus::Failed,
        _ => match result_status {
            Some("passed") => ResultStatus::Passed,
            Some("skipped") => ResultStatus::Skipped,
            Some(_) => ResultStatus::Failed,
            None => ResultStatus::Untested,
        },
    }
}

// ---- ingestion ----------------------------------------------------------------

/// What happened to one case during ingestion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseOutcome {
    pub case: String,
    pub status: ResultStatus,
    pub elapsed: Option<String>,
    pub evidence: Vec<String>,
}

/// The result of ingesting a report into a run.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub run_id: String,
    /// Cases whose result was updated from the report.
    pub updated: Vec<CaseOutcome>,
    /// Member cases with no linked spec (nothing to run).
    pub skipped: Vec<String>,
    /// Reported tests that did not map to any member case (`file#title`).
    pub unmapped: Vec<String>,
}

/// Does a reported test belong to a planned case?
fn matches_case(pc: &PlannedCase, rt: &ReportedTest) -> bool {
    // Explicit (file, test) reference wins.
    if pc
        .explicit_tests
        .iter()
        .any(|(f, t)| t.eq_ignore_ascii_case(rt.title.trim()) && file_matches(f, &rt.file))
    {
        return true;
    }
    // Otherwise the convention: test title == case title, constrained to the
    // case's linked files.
    pc.title.trim().eq_ignore_ascii_case(rt.title.trim())
        && pc.files.iter().any(|f| file_matches(f, &rt.file))
}

/// Ingest reported tests into a run's results as automated outcomes. Cases with
/// multiple matching tests fail the run (any failure wins); duration sums.
pub fn ingest(
    paths: &Paths,
    run_id: &str,
    plan: &RunPlan,
    reported: &[ReportedTest],
    by: Option<&str>,
) -> Result<Summary> {
    let mut summary = Summary {
        run_id: run_id.to_string(),
        skipped: plan.skipped.clone(),
        ..Default::default()
    };
    let mut mapped = vec![false; reported.len()];

    for pc in &plan.cases {
        let hits: Vec<usize> = reported
            .iter()
            .enumerate()
            .filter(|(_, rt)| matches_case(pc, rt))
            .map(|(i, _)| i)
            .collect();
        if hits.is_empty() {
            continue;
        }
        let mut status = ResultStatus::Passed;
        let mut duration = 0.0;
        let mut evidence = Vec::new();
        let mut message: Option<String> = None;
        for &i in &hits {
            mapped[i] = true;
            let rt = &reported[i];
            duration += rt.duration_ms;
            evidence.extend(rt.attachments.iter().map(|p| relativize(paths, p)));
            match rt.status {
                ResultStatus::Failed => {
                    status = ResultStatus::Failed;
                    message = message.or_else(|| rt.message.clone());
                }
                ResultStatus::Skipped if status == ResultStatus::Passed && hits.len() == 1 => {
                    status = ResultStatus::Skipped;
                }
                _ => {}
            }
        }
        let elapsed = Some(fmt_elapsed(duration));
        runs::apply_result(
            paths,
            run_id,
            &pc.case,
            ResultInput {
                status,
                source: ResultSource::Automated,
                executed_by: by.map(str::to_string),
                // Failure message as the comment; clear it on a pass.
                comment: Some(message.clone().unwrap_or_default()),
                elapsed: elapsed.clone(),
                evidence: Some(evidence.clone()),
            },
        )?;
        summary.updated.push(CaseOutcome {
            case: pc.case.clone(),
            status,
            elapsed,
            evidence,
        });
    }

    for (i, rt) in reported.iter().enumerate() {
        if !mapped[i] {
            summary.unmapped.push(format!("{}#{}", rt.file, rt.title));
        }
    }
    Ok(summary)
}

/// Make an artifact path repo-relative when it lives under the repo root; keep
/// absolute paths (e.g. a system temp dir) as-is.
fn relativize(paths: &Paths, p: &str) -> String {
    let path = Path::new(p);
    let rel = path
        .strip_prefix(&paths.root)
        .ok()
        .map(|r| r.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string());
    rel.replace('\\', "/")
}

fn fmt_elapsed(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{}ms", ms.round() as i64)
    } else {
        format!("{:.1}s", ms / 1000.0)
    }
}

// ---- command construction & execution -----------------------------------------

/// Where a run's JSON report is written (under the gitignored cache).
fn report_path(paths: &Paths, run_id: &str) -> PathBuf {
    paths
        .th
        .join(".testhound")
        .join("cache")
        .join("runs")
        .join(run_id)
        .join("report.json")
}

/// Map each configuration-option id to the Playwright `--project` it drives, for
/// every option that declares one. Configuration options are a TestHound
/// reporting dimension (browser × form-factor, etc.); only those explicitly
/// mapped to a real Playwright project translate into a `--project` flag.
pub fn project_map(paths: &Paths) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Ok(cfgs) = crate::repo::runs::list_configurations(paths) {
        for cfg in cfgs {
            for opt in cfg.options {
                if let Some(project) = opt.playwright_project {
                    map.insert(opt.id, project);
                }
            }
        }
    }
    map
}

/// Build the `playwright test` argument vector (after the program + leading
/// args from [`runner`]). Kept pure for testing. `projects` maps a run's
/// configuration-option ids to Playwright project names (see [`project_map`]);
/// options with no mapping are left to Playwright's default project(s).
pub fn build_args(
    plan: &RunPlan,
    run: &Run,
    headed: bool,
    projects: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut args = vec!["test".to_string()];
    args.extend(plan.files.iter().cloned());
    if !plan.greps.is_empty() {
        let pattern = plan
            .greps
            .iter()
            .map(|t| format!("({})", regex_escape(t)))
            .collect::<Vec<_>>()
            .join("|");
        args.push("--grep".to_string());
        args.push(pattern);
    }
    for cfg in &run.configuration {
        if let Some(project) = projects.get(cfg) {
            args.push(format!("--project={project}"));
        }
    }
    // Headed: show a real browser and run serially so it is watchable rather
    // than flashing many parallel windows.
    if headed {
        args.push("--headed".to_string());
        args.push("--workers=1".to_string());
    }
    args.push("--reporter=line,json".to_string());
    args
}

/// Escape regex metacharacters so a test title greps literally.
fn regex_escape(s: &str) -> String {
    const SPECIAL: &[char] = &[
        '\\', '.', '+', '*', '?', '(', ')', '|', '[', ']', '{', '}', '^', '$', '/',
    ];
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if SPECIAL.contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Load the run's member cases as [`CaseLink`]s (id, title, spec refs).
fn member_links(paths: &Paths, run: &Run) -> Result<Vec<CaseLink>> {
    let mut links = Vec::with_capacity(run.includes.cases.len());
    for id in &run.includes.cases {
        match crate::repo::load_case(paths, id) {
            Ok(case) => links.push(CaseLink {
                id: case.front.id,
                title: case.front.title,
                specs: case.front.automation.specs,
            }),
            // A member case that no longer exists is simply unrunnable.
            Err(_) => links.push(CaseLink {
                id: id.clone(),
                title: id.clone(),
                specs: vec![],
            }),
        }
    }
    Ok(links)
}

/// Run Playwright for a run and ingest the results. `on_line` receives each
/// line of process output for live streaming; the caller turns those into
/// events. Returns the ingestion summary.
pub fn execute<F: FnMut(&str)>(
    paths: &Paths,
    run: &Run,
    by: Option<&str>,
    headed: bool,
    mut on_line: F,
) -> Result<Summary> {
    let pw = detect(&paths.root);
    if !pw.detected {
        return Err(Error::Playwright(
            "no playwright.config found in the repo root".into(),
        ));
    }

    let links = member_links(paths, run)?;
    let plan = plan(&links);
    if plan.files.is_empty() {
        on_line("No linked specs in this run; nothing to execute.");
        return Ok(Summary {
            run_id: run.id.clone(),
            skipped: plan.skipped.clone(),
            ..Default::default()
        });
    }
    validate_spec_files(paths, &pw, &plan.files)?;

    let report = report_path(paths, &run.id);
    if let Some(parent) = report.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(&report);

    let (program, lead) = runner(&paths.root);
    let args = build_args(&plan, run, headed, &project_map(paths));
    let target = load_target(paths);
    let target_env = target_env(&target);
    if let Some(url) = target.base_url.as_deref().filter(|u| !u.trim().is_empty()) {
        on_line(&format!("Target base URL: {url}"));
    }
    on_line(&format!("$ {program} {} {}", lead.join(" "), args.join(" ")));

    // Capture the JSON reporter to a file (via env), stream the line reporter
    // from stdout, and route stderr to its own file so a chatty stderr can't
    // fill its pipe buffer and deadlock the stdout reader.
    let stderr_log = report.with_file_name("stderr.log");
    let stderr_file = std::fs::File::create(&stderr_log)?;
    let mut child = Command::new(&program)
        .args(&lead)
        .args(&args)
        .current_dir(&paths.root)
        .env("PLAYWRIGHT_JSON_OUTPUT_NAME", &report)
        .env("FORCE_COLOR", "0")
        .envs(target_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| Error::Playwright(format!("failed to launch {program}: {e}")))?;

    use std::io::{BufRead, BufReader};
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
            on_line(&line);
        }
    }
    let _status = child
        .wait()
        .map_err(|e| Error::Playwright(format!("playwright did not exit cleanly: {e}")))?;

    // Surface any stderr output after the process exits.
    if let Ok(err) = std::fs::read_to_string(&stderr_log) {
        for line in err.lines().filter(|l| !l.trim().is_empty()) {
            on_line(line);
        }
    }

    // A missing report means Playwright failed before writing one (bad config,
    // no matching tests, install error). Surface it rather than silently
    // reporting zero results.
    let json = std::fs::read_to_string(&report).map_err(|_| {
        Error::Playwright(
            "playwright produced no JSON report (check the Activity log for errors)".into(),
        )
    })?;
    let reported = parse_report(&json)?;
    ingest(paths, &run.id, &plan, &reported, by)
}

/// Run a single case's linked spec(s) directly and stream the output, WITHOUT
/// creating a run or ingesting results. This is the "watch it in action"
/// preview: nothing is persisted. Test failures are not an error here (the user
/// watched them); only a failure to launch Playwright is.
pub fn run_spec_preview<F: FnMut(&str)>(
    paths: &Paths,
    specs: &[String],
    headed: bool,
    mut on_line: F,
) -> Result<()> {
    let pw = detect(&paths.root);
    if !pw.detected {
        return Err(Error::Playwright(
            "no playwright.config found in the repo root".into(),
        ));
    }
    let refs: Vec<SpecRef> = specs.iter().map(|s| parse_spec_ref(s)).collect();
    let files: BTreeSet<String> = refs.iter().map(|r| r.file.clone()).collect();
    if files.is_empty() {
        return Err(Error::Playwright(
            "this case has no linked spec to run".into(),
        ));
    }
    validate_spec_files(paths, &pw, &files)?;
    let greps: Vec<String> = refs.iter().filter_map(|r| r.test.clone()).collect();

    let mut args = vec!["test".to_string()];
    args.extend(files.iter().cloned());
    if !greps.is_empty() {
        let pattern = greps
            .iter()
            .map(|t| format!("({})", regex_escape(t)))
            .collect::<Vec<_>>()
            .join("|");
        args.push("--grep".to_string());
        args.push(pattern);
    }
    if headed {
        args.push("--headed".to_string());
        args.push("--workers=1".to_string());
    }
    args.push("--reporter=line".to_string());

    let (program, lead) = runner(&paths.root);
    let target = load_target(paths);
    let env = target_env(&target);
    if let Some(url) = target.base_url.as_deref().filter(|u| !u.trim().is_empty()) {
        on_line(&format!("Target base URL: {url}"));
    }
    on_line(&format!("$ {program} {} {}", lead.join(" "), args.join(" ")));

    let mut child = Command::new(&program)
        .args(&lead)
        .args(&args)
        .current_dir(&paths.root)
        .env("FORCE_COLOR", "0")
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Playwright(format!("failed to launch {program}: {e}")))?;

    let stderr = child.stderr.take();
    let stderr_handle = stderr.map(|err| {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            BufReader::new(err)
                .lines()
                .map_while(std::result::Result::ok)
                .collect::<Vec<_>>()
        })
    });
    use std::io::{BufRead, BufReader};
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
            on_line(&line);
        }
    }
    // A non-zero exit just means the test failed; the user watched it, so this
    // is not a command error. Surface stderr for context.
    let _ = child.wait();
    if let Some(handle) = stderr_handle {
        if let Ok(lines) = handle.join() {
            for line in lines.iter().filter(|l| !l.trim().is_empty()) {
                on_line(line);
            }
        }
    }
    Ok(())
}

/// Open a trace in the Playwright trace viewer (`playwright show-trace`). The
/// trace path is validated to live inside the repo before launching.
pub fn show_trace(paths: &Paths, trace: &str) -> Result<()> {
    let abs = paths.root.join(trace);
    let canon = abs
        .canonicalize()
        .map_err(|_| Error::Playwright(format!("trace not found: {trace}")))?;
    let root = paths
        .root
        .canonicalize()
        .unwrap_or_else(|_| paths.root.clone());
    if !canon.starts_with(&root) {
        return Err(Error::Playwright("trace path is outside the repo".into()));
    }
    let (program, mut lead) = runner(&paths.root);
    lead.push("show-trace".to_string());
    Command::new(&program)
        .args(&lead)
        .arg(&canon)
        .current_dir(&paths.root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::Playwright(format!("failed to open trace viewer: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spec_refs() {
        assert_eq!(
            parse_spec_ref("tests/checkout/add.spec.ts#add single item"),
            SpecRef {
                file: "tests/checkout/add.spec.ts".into(),
                test: Some("add single item".into()),
            }
        );
        assert_eq!(
            parse_spec_ref("./tests/auth/login.spec.ts"),
            SpecRef {
                file: "tests/auth/login.spec.ts".into(),
                test: None,
            }
        );
    }

    #[test]
    fn file_matching_is_suffix_tolerant() {
        assert!(file_matches("tests/a.spec.ts", "tests/a.spec.ts"));
        assert!(file_matches(
            "/repo/tests/a.spec.ts",
            "tests/a.spec.ts"
        ));
        assert!(file_matches("tests/a.spec.ts", "a.spec.ts"));
        assert!(!file_matches("tests/a.spec.ts", "tests/b.spec.ts"));
    }

    #[test]
    fn plan_collects_files_titles_and_skips() {
        let members = vec![
            CaseLink {
                id: "TC-1".into(),
                title: "Login works".into(),
                specs: vec!["tests/auth/login.spec.ts".into()],
            },
            CaseLink {
                id: "TC-2".into(),
                title: "Add to cart".into(),
                specs: vec!["tests/checkout/cart.spec.ts#add single item".into()],
            },
            CaseLink {
                id: "TC-3".into(),
                title: "Unlinked".into(),
                specs: vec![],
            },
        ];
        let p = plan(&members);
        assert_eq!(p.skipped, vec!["TC-3"]);
        assert_eq!(p.cases.len(), 2);
        assert!(p.files.contains(&"tests/auth/login.spec.ts".to_string()));
        assert!(p.files.contains(&"tests/checkout/cart.spec.ts".to_string()));
        // Grep includes both case titles and the explicit test title.
        assert!(p.greps.contains(&"Login works".to_string()));
        assert!(p.greps.contains(&"add single item".to_string()));
    }

    #[test]
    fn build_args_greps_and_projects() {
        let plan = RunPlan {
            cases: vec![],
            skipped: vec![],
            files: vec!["tests/a.spec.ts".into()],
            greps: vec!["a (b)".into()],
        };
        let run = Run {
            id: "r".into(),
            name: "R".into(),
            milestone: None,
            configuration: vec!["chromium-desktop".into()],
            description: None,
            includes: Default::default(),
            assignee: None,
            state: Default::default(),
            created: None,
            updated: None,
        };
        // The configuration option maps to the real Playwright project name.
        let projects = BTreeMap::from([("chromium-desktop".to_string(), "chromium".to_string())]);
        let args = build_args(&plan, &run, false, &projects);
        assert!(args.contains(&"tests/a.spec.ts".to_string()));
        assert!(!args.contains(&"--headed".to_string()));
        // Headed adds --headed and forces a single worker so it is watchable.
        let headed = build_args(&plan, &run, true, &projects);
        assert!(headed.contains(&"--headed".to_string()));
        assert!(headed.contains(&"--workers=1".to_string()));
        let gi = args.iter().position(|a| a == "--grep").unwrap();
        assert_eq!(args[gi + 1], "(a \\(b\\))");
        assert!(args.contains(&"--project=chromium".to_string()));
        assert!(args.contains(&"--reporter=line,json".to_string()));
    }

    #[test]
    fn build_args_omits_project_when_option_is_unmapped() {
        let plan = RunPlan {
            cases: vec![],
            skipped: vec![],
            files: vec!["tests/a.spec.ts".into()],
            greps: vec![],
        };
        let run = Run {
            id: "r".into(),
            name: "R".into(),
            milestone: None,
            configuration: vec!["chromium-desktop".into()],
            description: None,
            includes: Default::default(),
            assignee: None,
            state: Default::default(),
            created: None,
            updated: None,
        };
        // No mapping for the option: Playwright runs its default project(s), so
        // no --project flag is emitted (rather than a bogus one Playwright rejects).
        let args = build_args(&plan, &run, false, &BTreeMap::new());
        assert!(!args.iter().any(|a| a.starts_with("--project=")));
    }

    #[test]
    fn target_env_exposes_base_url_and_custom_vars() {
        let mut target = TestTarget {
            base_url: Some("https://staging.example.com".into()),
            ..Default::default()
        };
        target.env.insert("API_TOKEN".into(), "abc".into());
        let env = target_env(&target);
        assert!(env.contains(&("BASE_URL".into(), "https://staging.example.com".into())));
        assert!(env.contains(&(
            "PLAYWRIGHT_TEST_BASE_URL".into(),
            "https://staging.example.com".into()
        )));
        assert!(env.contains(&("API_TOKEN".into(), "abc".into())));
    }

    #[test]
    fn target_env_empty_when_unset() {
        assert!(target_env(&TestTarget::default()).is_empty());
    }

    const REPORT: &str = r#"
    {
      "suites": [
        {
          "file": "tests/auth/login.spec.ts",
          "specs": [
            {
              "title": "Login works",
              "tests": [
                { "status": "expected", "results": [ { "status": "passed", "duration": 4200, "attachments": [] } ] }
              ]
            }
          ],
          "suites": [
            {
              "specs": [
                {
                  "title": "Add to cart",
                  "file": "tests/checkout/cart.spec.ts",
                  "tests": [
                    { "status": "unexpected", "results": [ { "status": "failed", "duration": 800,
                      "attachments": [ { "name": "trace", "path": "test-results/cart/trace.zip" } ],
                      "errors": [ { "message": "\u001b[31mExpect\u001b[0m: badge to be 1\nat cart.spec.ts:12" } ] } ] }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }"#;

    #[test]
    fn parses_nested_report() {
        let tests = parse_report(REPORT).unwrap();
        assert_eq!(tests.len(), 2);
        let login = tests.iter().find(|t| t.title == "Login works").unwrap();
        assert_eq!(login.status, ResultStatus::Passed);
        assert_eq!(login.file, "tests/auth/login.spec.ts");
        assert!((login.duration_ms - 4200.0).abs() < f64::EPSILON);

        let cart = tests.iter().find(|t| t.title == "Add to cart").unwrap();
        assert_eq!(cart.status, ResultStatus::Failed);
        assert_eq!(cart.file, "tests/checkout/cart.spec.ts");
        assert_eq!(cart.attachments, vec!["test-results/cart/trace.zip"]);
        // ANSI stripped, first line kept.
        assert_eq!(cart.message.as_deref(), Some("Expect: badge to be 1"));
    }

    #[test]
    fn detect_test_dir_scrapes_config() {
        let cfg = std::env::temp_dir().join(format!("th-cfg-{}.ts", std::process::id()));
        std::fs::write(&cfg, "export default { testDir: './playwright', use: {} }").unwrap();
        assert_eq!(detect_test_dir(&cfg).as_deref(), Some("playwright"));
        std::fs::remove_file(&cfg).ok();
    }

    #[test]
    fn validation_flags_missing_and_undiscoverable_specs() {
        let root = std::env::temp_dir().join(format!("th-validate-{}", std::process::id()));
        std::fs::create_dir_all(root.join("playwright")).unwrap();
        std::fs::create_dir_all(root.join("tests")).unwrap();
        std::fs::write(
            root.join("playwright.config.ts"),
            "export default { testDir: './playwright' }",
        )
        .unwrap();
        std::fs::write(root.join("playwright/a.spec.ts"), "test").unwrap();
        std::fs::write(root.join("tests/b.spec.ts"), "test").unwrap();
        let paths = Paths::new(&root, "testhound");
        let info = detect(&root);

        // Inside testDir: fine.
        assert!(validate_spec_files(&paths, &info, &["playwright/a.spec.ts".to_string()]).is_ok());
        // Exists but outside testDir: Playwright would say "No tests found".
        let err = validate_spec_files(&paths, &info, &["tests/b.spec.ts".to_string()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("outside Playwright's testDir"), "{err}");
        // Missing file.
        let err = validate_spec_files(&paths, &info, &["playwright/gone.spec.ts".to_string()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("not found on disk"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn elapsed_formatting() {
        assert_eq!(fmt_elapsed(800.0), "800ms");
        assert_eq!(fmt_elapsed(4200.0), "4.2s");
    }
}
