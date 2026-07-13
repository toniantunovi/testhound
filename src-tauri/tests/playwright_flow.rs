//! End-to-end exercise of Playwright result ingestion against a real temporary
//! repo, without needing a live Playwright install: seed a project, build a run
//! from linked cases, then feed a synthetic JSON report through the same
//! `parse_report` + `ingest` path the executor uses and assert the run's
//! results become automated outcomes with elapsed times and evidence.

use std::path::PathBuf;
use testhound_lib::app::sample;
use testhound_lib::domain::{
    AutomationState, IncludeMode, ResultSource, ResultStatus, RunState, Suite,
};
use testhound_lib::playwright::{self, CaseLink};
use testhound_lib::repo::runs::{self, CreateRun};
use testhound_lib::repo::{self, Paths};

fn tmp_repo() -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "testhound-pw-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    git2::Repository::init(&base).unwrap();
    base
}

/// Build the plan the executor would build, by loading member cases' spec refs.
fn plan_for(paths: &Paths, cases: &[&str]) -> playwright::RunPlan {
    let links: Vec<CaseLink> = cases
        .iter()
        .map(|id| {
            let c = repo::load_case(paths, id).unwrap();
            CaseLink {
                id: c.front.id,
                title: c.front.title,
                specs: c.front.automation.specs,
            }
        })
        .collect();
    playwright::plan(&links)
}

#[test]
fn ingests_a_synthetic_report_end_to_end() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    // A run over one linked+passing case, one linked+failing case, and one
    // unautomated case (which must be reported as skipped).
    let run = runs::create_run(
        &paths,
        CreateRun {
            name: "Automated smoke".into(),
            milestone: None,
            configuration: vec!["chromium-desktop".into()],
            description: None,
            assignee: None,
            mode: IncludeMode::Explicit,
            query: None,
            suites: vec![],
            cases: vec!["TC-0007".into(), "TC-0001".into(), "TC-0010".into()],
        },
    )
    .unwrap();
    assert_eq!(run.state, RunState::Planned);

    let plan = plan_for(&paths, &["TC-0007", "TC-0001", "TC-0010"]);
    // TC-0010 has no linked spec.
    assert_eq!(plan.skipped, vec!["TC-0010"]);
    assert_eq!(plan.cases.len(), 2);

    // Resolve the linked spec files/titles from the plan so the report matches
    // whatever slug the seed produced.
    let tc7 = plan.cases.iter().find(|c| c.case == "TC-0007").unwrap();
    let tc1 = plan.cases.iter().find(|c| c.case == "TC-0001").unwrap();
    let (f7, t7) = (tc7.files[0].clone(), tc7.title.clone());
    let (f1, t1) = (tc1.files[0].clone(), tc1.title.clone());

    let report = format!(
        r#"{{
          "suites": [
            {{ "file": "{f7}", "specs": [
              {{ "title": "{t7}", "tests": [
                {{ "status": "expected", "results": [
                  {{ "status": "passed", "duration": 4200,
                     "attachments": [ {{ "name": "trace", "path": "test-results/tc7/trace.zip" }} ] }} ] }} ] }}
            ] }},
            {{ "file": "{f1}", "specs": [
              {{ "title": "{t1}", "tests": [
                {{ "status": "unexpected", "results": [
                  {{ "status": "failed", "duration": 900,
                     "errors": [ {{ "message": "Expected dashboard, got login" }} ] }} ] }} ] }}
            ] }}
          ]
        }}"#
    );

    let reported = playwright::parse_report(&report).unwrap();
    assert_eq!(reported.len(), 2);

    let summary =
        playwright::ingest(&paths, &run.id, &plan, &reported, Some("playwright")).unwrap();
    assert_eq!(summary.updated.len(), 2);
    assert_eq!(summary.skipped, vec!["TC-0010"]);
    assert!(summary.unmapped.is_empty());

    // The results were written back to disk as automated outcomes and the run
    // advanced out of `planned`.
    let detail = runs::load_run(&paths, &run.id).unwrap();
    assert_eq!(detail.run.state, RunState::InProgress);

    let r7 = detail.rows.iter().find(|r| r.case == "TC-0007").unwrap();
    assert_eq!(r7.status, ResultStatus::Passed);
    assert_eq!(r7.source, ResultSource::Automated);
    assert_eq!(r7.elapsed.as_deref(), Some("4.2s"));
    assert_eq!(r7.evidence, vec!["test-results/tc7/trace.zip"]);
    assert_eq!(r7.executed_by.as_deref(), Some("playwright"));
    assert_eq!(r7.attempts, 1);

    let r1 = detail.rows.iter().find(|r| r.case == "TC-0001").unwrap();
    assert_eq!(r1.status, ResultStatus::Failed);
    assert_eq!(r1.source, ResultSource::Automated);
    assert_eq!(r1.elapsed.as_deref(), Some("900ms"));
    assert_eq!(r1.comment.as_deref(), Some("Expected dashboard, got login"));

    // TC-0010 stayed untested (nothing to run).
    let r10 = detail.rows.iter().find(|r| r.case == "TC-0010").unwrap();
    assert_eq!(r10.status, ResultStatus::Untested);

    // A second ingest (re-run) appends history and replaces evidence rather than
    // duplicating it.
    let report2 = format!(
        r#"{{ "suites": [ {{ "file": "{f7}", "specs": [
          {{ "title": "{t7}", "tests": [ {{ "status": "expected", "results": [
            {{ "status": "passed", "duration": 3100,
               "attachments": [ {{ "name": "trace", "path": "test-results/tc7/trace-2.zip" }} ] }} ] }} ] }}
        ] }} ] }}"#
    );
    let reported2 = playwright::parse_report(&report2).unwrap();
    let plan2 = plan_for(&paths, &["TC-0007"]);
    playwright::ingest(&paths, &run.id, &plan2, &reported2, Some("playwright")).unwrap();
    let detail = runs::load_run(&paths, &run.id).unwrap();
    let r7 = detail.rows.iter().find(|r| r.case == "TC-0007").unwrap();
    assert_eq!(r7.attempts, 2);
    assert_eq!(r7.evidence, vec!["test-results/tc7/trace-2.zip"]);

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn unmapped_tests_are_reported() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    let run = runs::create_run(
        &paths,
        CreateRun {
            name: "Only TC-0007".into(),
            milestone: None,
            configuration: vec![],
            description: None,
            assignee: None,
            mode: IncludeMode::Explicit,
            query: None,
            suites: vec![],
            cases: vec!["TC-0007".into()],
        },
    )
    .unwrap();
    let plan = plan_for(&paths, &["TC-0007"]);

    // A report for a test that belongs to no member case.
    let report = r#"{ "suites": [ { "file": "tests/misc/orphan.spec.ts", "specs": [
        { "title": "some orphan test", "tests": [ { "status": "expected",
          "results": [ { "status": "passed", "duration": 10 } ] } ] } ] } ] }"#;
    let reported = playwright::parse_report(report).unwrap();
    let summary = playwright::ingest(&paths, &run.id, &plan, &reported, None).unwrap();

    assert!(summary.updated.is_empty());
    assert_eq!(
        summary.unmapped,
        vec!["tests/misc/orphan.spec.ts#some orphan test"]
    );

    std::fs::remove_dir_all(&root).ok();
}

/// Drive the real subprocess path with a stub `playwright` binary that writes a
/// JSON report, proving env wiring, stdout streaming, and report ingestion work
/// without a real Playwright install.
#[cfg(unix)]
#[test]
fn execute_spawns_runner_and_ingests() {
    use std::os::unix::fs::PermissionsExt;

    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);

    // A config so detect() reports Playwright present.
    std::fs::write(root.join("playwright.config.ts"), "export default {};\n").unwrap();

    // One suite + one linked case.
    repo::create_suite(
        &paths,
        &Suite {
            id: "checkout".into(),
            name: "Checkout".into(),
            description: None,
            order: 10,
        },
    )
    .unwrap();
    let mut case = repo::new_case(
        "TC-0100".into(),
        "Add to cart".into(),
        "checkout".into(),
        "## Steps\n1. Do it\n",
    );
    case.front.automation.state = AutomationState::Linked;
    case.front.automation.specs = vec!["tests/checkout/cart.spec.ts".into()];
    repo::save_case(&paths, &case).unwrap();

    // The linked spec must exist on disk; execute() validates it before spawning.
    std::fs::create_dir_all(root.join("tests/checkout")).unwrap();
    std::fs::write(root.join("tests/checkout/cart.spec.ts"), "// stub\n").unwrap();

    let run = runs::create_run(
        &paths,
        CreateRun {
            name: "Automated".into(),
            milestone: None,
            configuration: vec![],
            description: None,
            assignee: None,
            mode: IncludeMode::Explicit,
            query: None,
            suites: vec![],
            cases: vec!["TC-0100".into()],
        },
    )
    .unwrap();

    // A stub local runner: it ignores its args and writes a JSON report to the
    // path TestHound passes via PLAYWRIGHT_JSON_OUTPUT_NAME.
    let bin_dir = root.join("node_modules").join(".bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let bin = bin_dir.join("playwright");
    std::fs::write(
        &bin,
        r#"#!/bin/sh
echo "Running 1 test using 1 worker"
cat > "$PLAYWRIGHT_JSON_OUTPUT_NAME" <<'JSON'
{ "suites": [ { "file": "tests/checkout/cart.spec.ts", "specs": [
  { "title": "Add to cart", "tests": [ { "status": "expected",
    "results": [ { "status": "passed", "duration": 2500, "attachments": [] } ] } ] } ] } ] }
JSON
echo "1 passed (2.5s)"
"#,
    )
    .unwrap();
    let mut perms = std::fs::metadata(&bin).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&bin, perms).unwrap();

    let run_meta = runs::load_run(&paths, &run.id).unwrap().run;
    let mut lines = Vec::new();
    let summary = playwright::execute(&paths, &run_meta, Some("playwright"), false, |l| {
        lines.push(l.to_string())
    })
    .unwrap();

    assert_eq!(summary.updated.len(), 1);
    assert!(lines.iter().any(|l| l.contains("Running 1 test")));

    let detail = runs::load_run(&paths, &run.id).unwrap();
    let r = detail.rows.iter().find(|r| r.case == "TC-0100").unwrap();
    assert_eq!(r.status, ResultStatus::Passed);
    assert_eq!(r.source, ResultSource::Automated);
    assert_eq!(r.elapsed.as_deref(), Some("2.5s"));
    assert_eq!(detail.run.state, RunState::InProgress);

    std::fs::remove_dir_all(&root).ok();
}
