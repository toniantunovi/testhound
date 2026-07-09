//! End-to-end exercise of the runs layer against a real temporary Git repo:
//! seed -> list runs -> inspect progress -> record a result -> create a fresh
//! run from a filter and complete it.

use std::path::PathBuf;
use testhound_lib::app::sample;
use testhound_lib::domain::{IncludeMode, ResultSource, ResultStatus, RunState};
use testhound_lib::repo::runs::{self, CreateRun};
use testhound_lib::repo::{self, Paths};

fn tmp_repo() -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "testhound-runs-{}-{}",
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

#[test]
fn seed_list_and_record_results() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    // Configurations and milestones landed.
    assert_eq!(runs::list_configurations(&paths).unwrap().len(), 1);
    assert_eq!(runs::list_milestones(&paths).unwrap().len(), 2);

    // Three seeded runs.
    let all = runs::list_runs(&paths).unwrap();
    assert_eq!(all.len(), 3);

    // Regression R3: filter "suite:checkout OR tag:p1" resolves to 8 cases,
    // 6 passed / 1 failed / 1 untested, and is left in progress.
    let r3 = all.iter().find(|r| r.name == "Regression R3").unwrap();
    assert_eq!(r3.state, RunState::InProgress);
    assert_eq!(r3.progress.total, 8);
    assert_eq!(r3.progress.passed, 6);
    assert_eq!(r3.progress.failed, 1);
    assert_eq!(r3.progress.untested, 1);
    assert_eq!(r3.progress.pass_rate(), 86); // 6 of 7 executed

    // The detail view joins case metadata; the untested case is TC-0010.
    let detail = runs::load_run(&paths, &r3.id).unwrap();
    assert_eq!(detail.rows.len(), 8);
    let tc10 = detail.rows.iter().find(|row| row.case == "TC-0010").unwrap();
    assert_eq!(tc10.status, ResultStatus::Untested);
    assert!(!tc10.title.is_empty());

    // Recording a result appends history and updates the row.
    runs::set_result(
        &paths,
        &r3.id,
        "TC-0010",
        ResultStatus::Passed,
        Some("Recovered on retry".into()),
        Some("marco".into()),
        ResultSource::Manual,
    )
    .unwrap();
    let detail = runs::load_run(&paths, &r3.id).unwrap();
    assert_eq!(detail.progress.untested, 0);
    assert_eq!(detail.progress.passed, 7);
    let tc10 = detail.rows.iter().find(|row| row.case == "TC-0010").unwrap();
    assert_eq!(tc10.status, ResultStatus::Passed);
    assert_eq!(tc10.attempts, 1);
    assert_eq!(tc10.comment.as_deref(), Some("Recovered on retry"));

    // A non-member case cannot be recorded against the run.
    assert!(runs::set_result(
        &paths,
        &r3.id,
        "TC-0002",
        ResultStatus::Passed,
        None,
        None,
        ResultSource::Manual,
    )
    .is_err());

    // Create a fresh explicit run, record and complete it.
    let fresh = runs::create_run(
        &paths,
        CreateRun {
            name: "Ad-hoc auth check".into(),
            milestone: None,
            configuration: vec!["chromium-desktop".into()],
            description: None,
            assignee: Some("lena".into()),
            mode: IncludeMode::Explicit,
            query: None,
            suites: vec![],
            cases: vec!["TC-0001".into(), "TC-0002".into()],
        },
    )
    .unwrap();
    assert_eq!(fresh.state, RunState::Planned);
    assert_eq!(fresh.includes.cases, vec!["TC-0001", "TC-0002"]);

    runs::set_result(
        &paths, &fresh.id, "TC-0001", ResultStatus::Passed, None, Some("lena".into()),
        ResultSource::Manual,
    )
    .unwrap();
    runs::set_result(
        &paths, &fresh.id, "TC-0002", ResultStatus::Blocked, None, Some("lena".into()),
        ResultSource::Manual,
    )
    .unwrap();
    runs::set_run_state(&paths, &fresh.id, RunState::Complete).unwrap();

    let reloaded = runs::load_run(&paths, &fresh.id).unwrap();
    assert_eq!(reloaded.run.state, RunState::Complete);
    assert_eq!(reloaded.progress.passed, 1);
    assert_eq!(reloaded.progress.blocked, 1);

    // Now four runs total.
    assert_eq!(runs::list_runs(&paths).unwrap().len(), 4);

    std::fs::remove_dir_all(&root).ok();
}
