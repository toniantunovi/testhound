//! End-to-end exercise of the file store against a real temporary Git repo:
//! scaffold -> seed -> list -> load -> edit -> save -> reload, plus Git status.

use std::path::PathBuf;
use testhound_lib::app::sample;
use testhound_lib::domain::AutomationState;
use testhound_lib::git;
use testhound_lib::repo::{self, Paths};

fn tmp_repo() -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "testhound-it-{}-{}",
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
fn scaffold_seed_and_roundtrip() {
    let root = tmp_repo();
    let th = "testhound";

    // Scaffold + seed the Acme Shop demo.
    let project = repo::scaffold(&root, "Acme Shop", th).unwrap();
    assert_eq!(project.name, "Acme Shop");

    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    // project.yml, links.yml and .gitignore all landed.
    assert!(root.join("testhound/project.yml").is_file());
    assert!(root.join("testhound/automation/links.yml").is_file());
    let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(gitignore.contains("testhound/.testhound/"));

    // Detection recognizes the project.
    assert_eq!(repo::detect(&root).as_deref(), Some("testhound"));

    // Five suites, mirroring the Figma tree.
    let suites = repo::list_suites(&paths).unwrap();
    assert_eq!(suites.len(), 5);
    assert!(suites.iter().any(|s| s.id == "checkout" && s.case_count > 0));

    // Ten seeded cases; TC-0007 is linked, TC-0008 is drifted.
    let cases = repo::list_cases(&paths).unwrap();
    assert_eq!(cases.len(), 10);
    let tc7 = cases.iter().find(|c| c.id == "TC-0007").unwrap();
    assert_eq!(tc7.automation_state, AutomationState::Linked);
    let tc8 = cases.iter().find(|c| c.id == "TC-0008").unwrap();
    assert_eq!(tc8.automation_state, AutomationState::Drifted);

    // Load a full case: front matter + parsed steps.
    let mut case = repo::load_case(&paths, "TC-0007").unwrap();
    assert_eq!(case.front.title, "Add item to cart from product page");
    assert_eq!(case.steps.len(), 3);
    assert!(case.steps[0].expected.is_some());

    // Edit the title and a step, then save and reload.
    case.front.title = "Add item to cart (revised)".into();
    case.body
        .push_str("\n## Notes\nRevised during integration test.\n");
    let saved = repo::save_case(&paths, &case).unwrap();
    assert_eq!(saved.front.title, "Add item to cart (revised)");

    let reloaded = repo::load_case(&paths, "TC-0007").unwrap();
    assert_eq!(reloaded.front.title, "Add item to cart (revised)");
    assert!(reloaded.body.contains("Revised during integration test."));

    // A brand-new case gets a monotonic id and is retrievable.
    let id = repo::next_case_id(&paths).unwrap();
    let fresh = repo::new_case(id.clone(), "Fresh case".into(), "search".into(), "## Steps\n1. Do a thing\n");
    repo::save_case(&paths, &fresh).unwrap();
    assert!(repo::load_case(&paths, &id).is_ok());
    assert_eq!(repo::list_cases(&paths).unwrap().len(), 11);

    // Git sees the new files as untracked changes.
    let repository = git::open(&root).unwrap();
    let status = git::status(&repository).unwrap();
    assert!(!status.clean);
    assert!(status.changed.iter().any(|f| f.path.contains("testhound/")));

    // Clean up.
    std::fs::remove_dir_all(&root).ok();
}
