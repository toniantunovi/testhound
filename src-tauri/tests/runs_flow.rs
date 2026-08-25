//! End-to-end exercise of the runs layer against a real temporary Git repo:
//! seed -> list runs -> inspect progress -> record a result -> create a fresh
//! run from a filter and complete it.

use std::path::PathBuf;
use testhound_lib::app::sample;
use testhound_lib::domain::{CaseType, IncludeMode, ResultSource, ResultStatus, RunState};
use testhound_lib::repo::runs::{self, CreateRun};
use testhound_lib::repo::{self, CaseFields, Paths};

fn tmp_repo() -> PathBuf {
    // Parallel tests can read the same nanosecond; the counter keeps each repo
    // distinct (see playwright_flow for the failure this prevents).
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir().join(format!(
        "testhound-runs-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
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
    // 5 passed / 1 failed / 1 blocked / 1 awaiting retest, and is left in
    // progress. Every member has a result, so nothing is untested.
    let r3 = all.iter().find(|r| r.name == "Regression R3").unwrap();
    assert_eq!(r3.state, RunState::InProgress);
    assert_eq!(r3.progress.total, 8);
    assert_eq!(r3.progress.passed, 5);
    assert_eq!(r3.progress.failed, 1);
    assert_eq!(r3.progress.blocked, 1);
    assert_eq!(r3.progress.retest, 1);
    assert_eq!(r3.progress.untested, 0);
    assert_eq!(r3.progress.pass_rate(), 63); // 5 of 8 executed

    // The detail view joins case metadata; TC-0010 is the blocked case.
    let detail = runs::load_run(&paths, &r3.id).unwrap();
    assert_eq!(detail.rows.len(), 8);
    let tc10 = detail.rows.iter().find(|row| row.case == "TC-0010").unwrap();
    assert_eq!(tc10.status, ResultStatus::Blocked);
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
    assert_eq!(detail.progress.blocked, 0);
    assert_eq!(detail.progress.passed, 6);
    let tc10 = detail.rows.iter().find(|row| row.case == "TC-0010").unwrap();
    assert_eq!(tc10.status, ResultStatus::Passed);
    // Second attempt: the seeded "blocked" is kept in the history.
    assert_eq!(tc10.attempts, 2);
    assert_eq!(tc10.comment.as_deref(), Some("Recovered on retry"));

    // Linking a bug is not another execution: the defects land on the run's
    // result, and the history and timestamp stay where the last attempt left
    // them.
    let before = detail
        .rows
        .iter()
        .find(|row| row.case == "TC-0010")
        .unwrap()
        .clone();
    runs::set_defects(
        &paths,
        &r3.id,
        "TC-0010",
        vec![
            "  AB-9222  ".into(),
            "https://example.atlassian.net/browse/AB-9223".into(),
            "AB-9222".into(),
            "   ".into(),
        ],
    )
    .unwrap();
    let detail = runs::load_run(&paths, &r3.id).unwrap();
    let tc10 = detail.rows.iter().find(|row| row.case == "TC-0010").unwrap();
    assert_eq!(
        tc10.defects,
        vec![
            "AB-9222".to_string(),
            "https://example.atlassian.net/browse/AB-9223".to_string()
        ],
        "trimmed and deduplicated"
    );
    assert_eq!(tc10.attempts, before.attempts);
    assert_eq!(tc10.executed_at, before.executed_at);
    assert_eq!(tc10.status, before.status);

    // Clearing them leaves the result otherwise untouched.
    runs::set_defects(&paths, &r3.id, "TC-0010", Vec::new()).unwrap();
    let detail = runs::load_run(&paths, &r3.id).unwrap();
    let tc10 = detail.rows.iter().find(|row| row.case == "TC-0010").unwrap();
    assert!(tc10.defects.is_empty());
    assert_eq!(tc10.comment.as_deref(), Some("Recovered on retry"));

    // A non-member case cannot carry a defect either.
    assert!(runs::set_defects(&paths, &r3.id, "TC-0002", vec!["AB-1".into()]).is_err());

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

/// The scenario a plural `type` exists for: a case is a functional test *and*
/// part of the regression sweep, and starting a regression run is then a matter
/// of asking for that type rather than hand-picking cases.
#[test]
fn a_regression_run_takes_every_case_of_that_type() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    // TC-0002 is a negative test; mark it as part of the sweep as well, the way
    // the case list's bulk edit does.
    repo::set_case_fields(
        &paths,
        &["TC-0002".to_string()],
        &CaseFields {
            type_add: vec![CaseType::Regression],
            ..CaseFields::default()
        },
    )
    .unwrap();

    let all = repo::list_cases(&paths).unwrap();
    let tc2 = all.iter().find(|c| c.id == "TC-0002").unwrap();
    // It gained the kind without losing the one it had.
    assert_eq!(tc2.kinds, vec![CaseType::Negative, CaseType::Regression]);
    let mut expected: Vec<String> = all
        .iter()
        .filter(|c| c.kinds.contains(&CaseType::Regression))
        .map(|c| c.id.clone())
        .collect();
    expected.sort();
    assert!(expected.len() > 1 && expected.contains(&"TC-0002".to_string()));

    let run = runs::create_run(
        &paths,
        CreateRun {
            name: "Regression R4".into(),
            milestone: None,
            configuration: vec![],
            description: None,
            assignee: None,
            mode: IncludeMode::Filter,
            query: Some("type:regression".into()),
            suites: vec![],
            cases: vec![],
        },
    )
    .unwrap();
    assert_eq!(run.includes.cases, expected);

    // A comma list keeps the either-or inside the term, so it survives being
    // ANDed with the suite: the two facets a picker would tick.
    let scoped = runs::create_run(
        &paths,
        CreateRun {
            name: "Checkout regression".into(),
            milestone: None,
            configuration: vec![],
            description: None,
            assignee: None,
            mode: IncludeMode::Filter,
            query: Some("type:regression,smoke AND suite:checkout".into()),
            suites: vec![],
            cases: vec![],
        },
    )
    .unwrap();
    assert!(!scoped.includes.cases.is_empty());
    let members = repo::list_cases(&paths).unwrap();
    for id in &scoped.includes.cases {
        let c = members.iter().find(|c| &c.id == id).unwrap();
        assert_eq!(c.suite, "checkout", "{id}");
        assert!(
            c.kinds.contains(&CaseType::Regression) || c.kinds.contains(&CaseType::Smoke),
            "{id}"
        );
    }
    assert!(!scoped.includes.cases.contains(&"TC-0002".to_string()), "auth is not checkout");

    std::fs::remove_dir_all(&root).ok();
}

/// Editing a run and deleting it, from the two ends that matter: a rename must
/// not silently re-snapshot membership against a corpus that has since grown,
/// and a redefinition takes the results of the cases it drops with it.
#[test]
fn editing_a_run_keeps_results_it_still_has_room_for_and_deleting_it_removes_them() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    let r3 = runs::list_runs(&paths)
        .unwrap()
        .into_iter()
        .find(|r| r.name == "Regression R3")
        .unwrap();
    let before = runs::load_run(&paths, &r3.id).unwrap().run;
    let members = before.includes.cases.clone();
    assert_eq!(members.len(), 8);

    // A case the run's filter ("suite:checkout OR tag:p1") would now match.
    let id = repo::next_case_id(&paths).unwrap();
    let fresh = repo::new_case(
        id.clone(),
        "Gift card at checkout".into(),
        "checkout".into(),
        "## Steps\n1. Pay with a gift card\n   - **Expected:** Accepted\n",
    );
    repo::save_case(&paths, &fresh).unwrap();

    // Metadata-only edit: the snapshot is kept verbatim, new case and all.
    let renamed = runs::update_run(
        &paths,
        &r3.id,
        CreateRun {
            name: "Regression R3 (week 2)".into(),
            milestone: before.milestone.clone(),
            configuration: before.configuration.clone(),
            description: Some("second pass".into()),
            assignee: Some("marco".into()),
            mode: before.includes.mode,
            query: before.includes.query.clone(),
            suites: before.includes.suites.clone(),
            cases: vec![],
        },
    )
    .unwrap();
    assert_eq!(renamed.id, r3.id, "the run keeps its id and its directory");
    assert_eq!(renamed.name, "Regression R3 (week 2)");
    assert_eq!(renamed.assignee.as_deref(), Some("marco"));
    assert_eq!(renamed.state, before.state, "editing is not a state change");
    assert_eq!(renamed.created, before.created);
    assert!(renamed.updated.is_some());
    assert_eq!(renamed.includes.cases, members);
    assert!(!renamed.includes.cases.contains(&id));
    // Recorded results survived untouched.
    assert_eq!(runs::load_run(&paths, &r3.id).unwrap().progress.untested, 0);

    // Redefining membership: hand-pick two of the eight. The six that leave
    // take their results with them.
    let kept: Vec<String> = members[..2].to_vec();
    let dropped = members[2].clone();
    let narrowed = runs::update_run(
        &paths,
        &r3.id,
        CreateRun {
            name: renamed.name.clone(),
            milestone: renamed.milestone.clone(),
            configuration: renamed.configuration.clone(),
            description: renamed.description.clone(),
            assignee: renamed.assignee.clone(),
            mode: IncludeMode::Explicit,
            query: None,
            suites: vec![],
            cases: kept.clone(),
        },
    )
    .unwrap();
    assert_eq!(narrowed.includes.mode, IncludeMode::Explicit);
    assert_eq!(narrowed.includes.cases, kept);
    let detail = runs::load_run(&paths, &r3.id).unwrap();
    assert_eq!(detail.progress.total, 2);
    assert_eq!(detail.rows.len(), 2);
    let results = root.join(th).join("runs").join(&r3.id).join("results");
    assert!(!results.join(format!("{dropped}.yml")).exists());
    for k in &kept {
        assert!(results.join(format!("{k}.yml")).exists(), "{k}");
    }

    // Deleting takes the run and its results with it.
    let count = runs::list_runs(&paths).unwrap().len();
    runs::delete_run(&paths, &r3.id).unwrap();
    assert!(!root.join(th).join("runs").join(&r3.id).exists());
    assert_eq!(runs::list_runs(&paths).unwrap().len(), count - 1);
    assert!(runs::load_run(&paths, &r3.id).is_err());
    // And deleting it twice is an error, not a silent success.
    assert!(runs::delete_run(&paths, &r3.id).is_err());

    std::fs::remove_dir_all(&root).ok();
}
