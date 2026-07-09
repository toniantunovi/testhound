//! End-to-end exercise of the M4 automation core against a real temp repo:
//! coverage aggregation, drift-on-save, and the accept flow linking a spec to a
//! case via front matter + `links.yml`.

use std::path::PathBuf;
use testhound_lib::app::sample;
use testhound_lib::automation;
use testhound_lib::domain::AutomationState;
use testhound_lib::repo::{self, Paths};

fn tmp_repo() -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "testhound-auto-{}-{}",
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
fn coverage_reflects_seed_and_finds_orphans() {
    let root = tmp_repo();
    let paths = Paths::new(&root, "testhound");
    repo::scaffold(&root, "Acme Shop", "testhound").unwrap();
    sample::seed(&paths).unwrap();

    // A spec on disk that no case references -> orphan.
    std::fs::create_dir_all(root.join("tests/checkout")).unwrap();
    std::fs::write(root.join("tests/orphan.spec.ts"), "test('x', () => {})").unwrap();

    let cov = automation::coverage(&paths).unwrap();
    assert_eq!(cov.rows.len(), 10);
    // Seed has linked + drifted cases; coverage counts them as automated.
    assert!(cov.automated > 0);
    assert!(cov.drifted >= 1);
    assert!(cov.coverage_pct > 0 && cov.coverage_pct <= 100);
    assert!(cov.orphans.iter().any(|o| o == "tests/orphan.spec.ts"));
    // Per-suite roll-up includes checkout.
    assert!(cov.per_suite.iter().any(|s| s.id == "checkout" && s.active > 0));
}

#[test]
fn editing_a_linked_case_marks_it_drifted() {
    let root = tmp_repo();
    let paths = Paths::new(&root, "testhound");
    repo::scaffold(&root, "Acme Shop", "testhound").unwrap();
    sample::seed(&paths).unwrap();

    // TC-0007 is seeded linked with source_hash == hash(body).
    let mut case = repo::load_case(&paths, "TC-0007").unwrap();
    assert_eq!(case.front.automation.state, AutomationState::Linked);

    // Change the body; saving recomputes drift.
    case.body.push_str("\n## Notes\nAdded a new expectation.\n");
    let saved = repo::save_case(&paths, &case).unwrap();
    assert_eq!(saved.front.automation.state, AutomationState::Drifted);
}

#[test]
fn accept_generation_links_spec_and_writes_links_yml() {
    let root = tmp_repo();
    let paths = Paths::new(&root, "testhound");
    repo::scaffold(&root, "Acme Shop", "testhound").unwrap();
    sample::seed(&paths).unwrap();

    // TC-0002 is seeded unautomated.
    let before = repo::load_case(&paths, "TC-0002").unwrap();
    assert_eq!(before.front.automation.state, AutomationState::None);

    let spec = "tests/auth/login-invalid.spec.ts#shows an error";
    let saved =
        automation::accept_generation(&paths, "TC-0002", vec![spec.to_string()], "claude-code")
            .unwrap();

    // Front matter now linked, with a source hash and generator recorded.
    assert_eq!(saved.front.automation.state, AutomationState::Linked);
    assert_eq!(saved.front.automation.specs, vec![spec.to_string()]);
    assert!(saved.front.automation.source_hash.is_some());
    assert_eq!(saved.front.automation.generator.as_deref(), Some("claude-code"));

    // links.yml gained the entry, parsed into path + test.
    let links = automation::load_links(&paths).unwrap();
    let link = links.links.iter().find(|l| l.case == "TC-0002").unwrap();
    assert_eq!(link.state, AutomationState::Linked);
    assert_eq!(link.specs.len(), 1);
    assert_eq!(link.specs[0].path, "tests/auth/login-invalid.spec.ts");
    assert_eq!(link.specs[0].test.as_deref(), Some("shows an error"));

    // Re-reading through coverage shows it as automated now.
    let cov = automation::coverage(&paths).unwrap();
    let row = cov.rows.iter().find(|r| r.case == "TC-0002").unwrap();
    assert_eq!(row.state, AutomationState::Linked);
}
