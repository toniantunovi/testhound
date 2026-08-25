//! End-to-end exercise of the file store against a real temporary Git repo:
//! scaffold -> seed -> list -> load -> edit -> save -> reload, plus Git status.

use std::path::PathBuf;
use testhound_lib::app::sample;
use testhound_lib::domain::{AutomationState, CaseStatus, Priority, Section};
use testhound_lib::git;
use testhound_lib::repo::{self, CaseFields, Paths};

fn tmp_repo() -> PathBuf {
    // Parallel tests can read the same nanosecond; the counter keeps each repo
    // distinct (see playwright_flow for the failure this prevents).
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir().join(format!(
        "testhound-it-{}-{}-{}",
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
    // Demo ticket references reach the list rows, which is what reference search
    // matches against.
    assert_eq!(tc7.references, vec!["AB-4821".to_string()]);
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

    // Deleting removes the file and it is gone from the listing.
    repo::delete_case(&paths, &id).unwrap();
    assert!(repo::load_case(&paths, &id).is_err());
    assert_eq!(repo::list_cases(&paths).unwrap().len(), 10);
    // Deleting a missing case surfaces an error rather than silently passing.
    assert!(repo::delete_case(&paths, "TC-9999").is_err());

    // Git sees the new files as untracked changes.
    let repository = git::open(&root).unwrap();
    let status = git::status(&repository).unwrap();
    assert!(!status.clean);
    assert!(status.changed.iter().any(|f| f.path.contains("testhound/")));

    // Clean up.
    std::fs::remove_dir_all(&root).ok();
}

/// Folders and manual ordering, end to end on real files: create a folder, file
/// a case into it, reorder the cases, and confirm the order survives a reload
/// and that a reorder never reaches outside its own group.
#[test]
fn sections_and_manual_order_round_trip() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    // A new folder lands in the suite and appends after the seeded ones.
    let seeded = repo::list_suites(&paths)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "checkout")
        .unwrap();
    let order = repo::next_order(seeded.sections.iter().map(|s| s.order));
    repo::create_section(
        &paths,
        "checkout",
        &Section {
            id: "totals".into(),
            name: "Totals".into(),
            parent: None,
            order,
        },
    )
    .unwrap();
    assert!(root
        .join("testhound/suites/checkout/sections/totals.yml")
        .is_file());
    let sections = repo::list_suites(&paths)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "checkout")
        .unwrap()
        .sections;
    assert_eq!(sections.last().unwrap().id, "totals");
    // Creating it twice is an error rather than a silent overwrite.
    assert!(repo::create_section(
        &paths,
        "checkout",
        &Section {
            id: "totals".into(),
            name: "Totals".into(),
            parent: None,
            order,
        },
    )
    .is_err());

    // Filing a case into a folder rewrites the front matter in place: same
    // suite, same file, so Git sees an edit and not a rename.
    let before = repo::load_case(&paths, "TC-0011").unwrap();
    let moved = repo::move_case(&paths, "TC-0011", "checkout", Some("totals")).unwrap();
    assert_eq!(moved.front.section.as_deref(), Some("totals"));
    assert_eq!(
        repo::list_cases(&paths)
            .unwrap()
            .iter()
            .find(|c| c.id == "TC-0011")
            .unwrap()
            .path,
        before_path(&before)
    );

    // Reorder the cart folder back to front; the order sticks on disk.
    repo::reorder_cases(
        &paths,
        "checkout",
        Some("cart"),
        &["TC-0010".into(), "TC-0009".into(), "TC-0007".into()],
    )
    .unwrap();
    let cart: Vec<(String, Option<i64>)> = repo::list_cases(&paths)
        .unwrap()
        .into_iter()
        .filter(|c| c.suite == "checkout" && c.section.as_deref() == Some("cart"))
        .map(|c| (c.id, c.order))
        .collect();
    let order_of = |id: &str| {
        cart.iter()
            .find(|(cid, _)| cid == id)
            .and_then(|(_, o)| *o)
            .unwrap()
    };
    assert_eq!(order_of("TC-0010"), 10);
    assert_eq!(order_of("TC-0009"), 20);
    assert_eq!(order_of("TC-0007"), 30);
    // TC-0008 was in the folder but not listed, so it keeps its place at the end.
    assert_eq!(order_of("TC-0008"), 40);

    // A case from another folder cannot be ordered into this one.
    assert!(repo::reorder_cases(&paths, "checkout", Some("cart"), &["TC-0014".into()]).is_err());

    // Moving a case out drops its manual order: it lands at the end of the
    // group it arrives in, not at whatever position it held before.
    let out = repo::move_case(&paths, "TC-0010", "search", None).unwrap();
    assert!(out.front.order.is_none());
    assert!(root
        .join("testhound/suites/search/cases")
        .read_dir()
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().starts_with("TC-0010-")));

    // Suites and folders reorder the same way.
    repo::reorder_suites(&paths, &["profile".into(), "checkout".into()]).unwrap();
    let suites = repo::list_suites(&paths).unwrap();
    assert_eq!(suites[0].id, "profile");
    assert_eq!(suites[1].id, "checkout");
    repo::reorder_sections(&paths, "checkout", &["payment".into()]).unwrap();
    let sections = repo::list_suites(&paths)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "checkout")
        .unwrap()
        .sections;
    assert_eq!(sections[0].id, "payment");

    std::fs::remove_dir_all(&root).ok();
}

/// Reordering has to survive the states a real repo gets into: a case whose front
/// matter will not parse, a folder file whose `id:` disagrees with its filename,
/// a folder file that is not valid YAML at all, and a group member the caller did
/// not list.
#[test]
fn reordering_tolerates_broken_and_mislabeled_files() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    // An unparseable case in the auth suite: `automation` as a scalar.
    std::fs::write(
        root.join("testhound/suites/auth/cases/TC-0900-broken.md"),
        "---\nid: TC-0900\ntitle: Broken\nsuite: auth\nautomation: linked\n---\n\n## Steps\n1. Go\n",
    )
    .unwrap();
    let cases = repo::list_cases(&paths).unwrap();
    assert!(cases.iter().any(|c| c.id == "TC-0900" && c.broken));

    // Reordering the rest of that suite still works: the broken case is simply
    // not a member, so the UI leaves it out of the sequence.
    repo::reorder_cases(&paths, "auth", None, &["TC-0002".into(), "TC-0001".into()]).unwrap();
    let auth: Vec<(String, Option<i64>)> = repo::list_cases(&paths)
        .unwrap()
        .into_iter()
        .filter(|c| c.suite == "auth")
        .map(|c| (c.id, c.order))
        .collect();
    assert!(auth.contains(&("TC-0002".to_string(), Some(10))));
    assert!(auth.contains(&("TC-0001".to_string(), Some(20))));
    // The broken case is left exactly as it was: no order written into it.
    assert!(auth.contains(&("TC-0900".to_string(), None)));
    // Naming it explicitly is still an error, which is what keeps a stale UI from
    // ordering a case into a group it does not belong to.
    assert!(repo::reorder_cases(&paths, "auth", None, &["TC-0900".into()]).is_err());

    // A member the caller does not mention keeps its relative position instead of
    // being renumbered into id order.
    repo::reorder_cases(
        &paths,
        "checkout",
        Some("cart"),
        &["TC-0010".into(), "TC-0009".into(), "TC-0008".into(), "TC-0007".into()],
    )
    .unwrap();
    repo::reorder_cases(&paths, "checkout", Some("cart"), &["TC-0007".into()]).unwrap();
    let mut cart: Vec<(i64, String)> = repo::list_cases(&paths)
        .unwrap()
        .into_iter()
        .filter(|c| c.section.as_deref() == Some("cart"))
        .map(|c| (c.order.unwrap(), c.id))
        .collect();
    cart.sort();
    assert_eq!(
        cart.iter().map(|(_, id)| id.as_str()).collect::<Vec<_>>(),
        // TC-0011 was in the folder but in neither call, so it stays last rather
        // than being renumbered into id order.
        ["TC-0007", "TC-0010", "TC-0009", "TC-0008", "TC-0011"],
        "the moved case leads; the others keep the order they had"
    );

    // Two files carrying the same id: a position cannot say which one it means, so
    // the reorder is refused instead of writing one twice and giving two cases the
    // same order. Nothing is written, and an empty request is a no-op.
    let cart_dir = root.join("testhound/suites/checkout/cases");
    let original = cart_dir
        .read_dir()
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("TC-0007-"))
                .unwrap_or(false)
        })
        .expect("TC-0007 file");
    std::fs::copy(&original, cart_dir.join("TC-0007-clone.md")).unwrap();
    let before = std::fs::read_to_string(&original).unwrap();
    assert!(repo::reorder_cases(
        &paths,
        "checkout",
        Some("cart"),
        &["TC-0009".into(), "TC-0007".into()],
    )
    .is_err());
    assert_eq!(std::fs::read_to_string(&original).unwrap(), before);
    assert!(repo::reorder_cases(&paths, "checkout", Some("cart"), &[]).is_ok());
    assert_eq!(std::fs::read_to_string(&original).unwrap(), before);
    std::fs::remove_file(cart_dir.join("TC-0007-clone.md")).unwrap();

    // A folder file whose `id:` contradicts its filename: the filename wins,
    // because every path (rename, delete, reorder) is built from the id.
    std::fs::write(
        root.join("testhound/suites/search/sections/regional.yml"),
        "id: totally-different\nname: Regional\norder: 10\n",
    )
    .unwrap_or_else(|_| {
        std::fs::create_dir_all(root.join("testhound/suites/search/sections")).unwrap();
        std::fs::write(
            root.join("testhound/suites/search/sections/regional.yml"),
            "id: totally-different\nname: Regional\norder: 10\n",
        )
        .unwrap()
    });
    // A folder file that is not valid YAML at all must not take the tree down.
    std::fs::write(
        root.join("testhound/suites/search/sections/junk.yml"),
        "name: [unclosed\n",
    )
    .unwrap();

    let search = repo::list_suites(&paths)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "search")
        .expect("suites still list after a malformed folder file");
    assert_eq!(
        search.sections.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["regional"],
        "the mislabeled folder is keyed by its filename, the junk one is skipped"
    );
    // And so the operations that build a path from that id actually work.
    repo::rename_section(&paths, "search", "regional", "Regional markets").unwrap();
    repo::reorder_sections(&paths, "search", &["regional".into()]).unwrap();

    std::fs::remove_dir_all(&root).ok();
}

/// The repo-relative path of a loaded case, derived from its suite and file name
/// the same way `list_cases` reports it.
/// Setting fields on a whole selection, the way the case list's selection bar
/// does: the values land, a case that already holds them is not rewritten, and
/// nothing else in the front matter is disturbed.
#[test]
fn bulk_field_edits_touch_only_the_fields_they_set() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    let path_of = |id: &str| {
        root.join(
            repo::list_cases(&paths)
                .unwrap()
                .into_iter()
                .find(|c| c.id == id)
                .unwrap()
                .path,
        )
    };

    // A key this app does not model, plus a comment: a bulk edit must not be
    // able to destroy either.
    let first = path_of("TC-0001");
    let content = std::fs::read_to_string(&first).unwrap();
    std::fs::write(
        &first,
        content.replacen("suite:", "component: login # hand-added\nsuite:", 1),
    )
    .unwrap();

    let fields = CaseFields {
        priority: Some(Priority::Low),
        kind: None,
        status: Some(CaseStatus::Deprecated),
    };
    let ids = vec!["TC-0001".to_string(), "TC-0002".to_string()];
    let changed = repo::set_case_fields(&paths, &ids, &fields).unwrap();
    assert_eq!(changed, ids);

    let after = repo::list_cases(&paths).unwrap();
    for id in &ids {
        let c = after.iter().find(|c| &c.id == id).unwrap();
        assert_eq!(c.status, CaseStatus::Deprecated, "{id}");
        assert_eq!(c.priority, Priority::Low, "{id}");
    }
    // The type was not part of the change, so it is whatever it was.
    let text = std::fs::read_to_string(&first).unwrap();
    assert!(text.contains("component: login # hand-added"));
    assert!(text.contains("type: "), "the untouched keys are still there");

    // Applying the same values again changes nothing at all: no ids reported,
    // and the files are byte-for-byte what they were.
    assert!(repo::set_case_fields(&paths, &ids, &fields)
        .unwrap()
        .is_empty());
    assert_eq!(std::fs::read_to_string(&first).unwrap(), text);

    // Setting nothing is not an error, and writes nothing.
    assert!(repo::set_case_fields(&paths, &ids, &CaseFields::default())
        .unwrap()
        .is_empty());

    // An id the repo does not have stops the batch rather than being skipped: a
    // stale selection must say so instead of half-applying in silence.
    assert!(repo::set_case_fields(&paths, &["TC-0900".into()], &fields).is_err());

    // Nor is a case whose front matter will not parse written to.
    let broken = root.join("testhound/suites/auth/cases/TC-0901-broken.md");
    std::fs::write(
        &broken,
        "---\nid: TC-0901\ntitle: Broken\nsuite: auth\nautomation: linked\n---\n\n## Steps\n1. Go\n",
    )
    .unwrap();
    let before = std::fs::read_to_string(&broken).unwrap();
    assert!(repo::set_case_fields(&paths, &["TC-0901".into()], &fields).is_err());
    assert_eq!(std::fs::read_to_string(&broken).unwrap(), before);

    std::fs::remove_dir_all(&root).ok();
}

fn before_path(case: &testhound_lib::domain::TestCase) -> String {
    format!(
        "testhound/suites/{}/cases/{}-{}.md",
        case.front.suite,
        case.front.id,
        slug::slugify(&case.front.title)
    )
}

/// A case whose front matter is corrupted (e.g. by a hand-edit from an agent)
/// must never silently disappear: it surfaces as a `broken` row with a salvaged
/// id and suite so the user can find and fix it.
#[test]
fn malformed_front_matter_surfaces_as_broken_row() {
    let root = tmp_repo();
    let th = "testhound";
    repo::scaffold(&root, "Acme Shop", th).unwrap();
    let paths = Paths::new(&root, th);
    sample::seed(&paths).unwrap();

    let before = repo::list_cases(&paths).unwrap();
    assert_eq!(before.len(), 10);

    // Corrupt TC-0007's front matter the way a bad automation edit would:
    // break the nested `automation` block's YAML while keeping the `---` fences.
    let path = root
        .join("testhound/suites/checkout/cases")
        .read_dir()
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("TC-0007-"))
                .unwrap_or(false)
        })
        .expect("TC-0007 file");
    // `automation` written as a scalar instead of the expected block: valid
    // YAML, but the typed front matter rejects it (a common bad hand-edit).
    std::fs::write(
        &path,
        "---\nid: TC-0007\ntitle: Add item to cart\nsuite: checkout\npriority: high\nautomation: linked\n---\n\n## Steps\n1. Open cart\n",
    )
    .unwrap();

    let after = repo::list_cases(&paths).unwrap();
    // Still ten rows: the corrupt case did not vanish.
    assert_eq!(after.len(), 10);
    let tc7 = after.iter().find(|c| c.id == "TC-0007").unwrap();
    assert!(tc7.broken, "corrupt case should be flagged broken");
    // Salvaged fields let the user locate the file for repair.
    assert_eq!(tc7.suite, "checkout");
    assert_eq!(tc7.automation_state, AutomationState::None);
    // Every healthy case is still parsed normally.
    assert!(after.iter().filter(|c| !c.broken).count() == 9);

    std::fs::remove_dir_all(&root).ok();
}
