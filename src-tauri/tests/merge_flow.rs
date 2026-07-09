//! End-to-end exercise of the M5 semantic 3-way merge against a real Git merge
//! conflict: two branches edit the same case file differently, `git merge`
//! leaves a conflict in the index, and TestHound builds a field-level merge,
//! resolves it with per-field picks, and stages a clean file. Also covers
//! `next_case_id` collision detection and renumber-with-relink.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use git2::{Repository, Signature};
use testhound_lib::domain::Priority;
use testhound_lib::merge::{self, Side};
use testhound_lib::repo::{self, Paths};

fn tmp_repo() -> (Repository, PathBuf) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir().join(format!(
        "testhound-merge-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let repo = Repository::init(&base).unwrap();
    (repo, base)
}

fn case_file(title: &str, priority: &str) -> String {
    format!(
        "---\nid: TC-0007\ntitle: {title}\nsuite: checkout\npriority: {priority}\ntype: functional\nstatus: active\n---\n\n## Preconditions\n- Logged in\n\n## Steps\n1. Open the cart\n   - **Expected:** Cart is shown\n"
    )
}

fn commit_all(repo: &Repository, root: &Path, msg: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Test", "t@example.com").unwrap();
    let parents: Vec<git2::Commit> = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|o| repo.find_commit(o).ok())
        .into_iter()
        .collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let _ = root;
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
        .unwrap()
}

fn write_case(root: &Path, name: &str, content: &str) {
    let dir = root.join("testhound/suites/checkout/cases");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(name), content).unwrap();
}

/// Build a base commit, two divergent branches editing the same case, then
/// merge them so the index holds a real conflict.
fn conflicted_repo() -> (Repository, PathBuf, Paths) {
    let (repo, root) = tmp_repo();
    let paths = Paths::new(&root, "testhound");
    repo::scaffold(&root, "Acme Shop", "testhound").unwrap();

    // Base: title "Add to cart", priority medium.
    write_case(&root, "TC-0007-add.md", &case_file("Add to cart", "medium"));
    let base = commit_all(&repo, &root, "base");
    let main = repo.head().unwrap().shorthand().unwrap().to_string();

    // Branch "theirs" from base: bump priority to critical only.
    repo.branch("theirs", &repo.find_commit(base).unwrap(), true)
        .unwrap();
    repo.set_head("refs/heads/theirs").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    write_case(&root, "TC-0007-add.md", &case_file("Add to cart", "critical"));
    let their = commit_all(&repo, &root, "theirs: bump priority");

    // Back to main and edit title + priority differently.
    repo.set_head(&format!("refs/heads/{main}")).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    write_case(&root, "TC-0007-add.md", &case_file("Add item to cart", "high"));
    commit_all(&repo, &root, "ours: retitle + bump priority");

    // Merge theirs -> conflict in the index. Scope the annotated commit so its
    // borrow of `repo` ends before we return the owned repo.
    {
        let their_annotated = repo.find_annotated_commit(their).unwrap();
        repo.merge(&[&their_annotated], None, None).unwrap();
    }
    assert!(repo.index().unwrap().has_conflicts());

    (repo, root, paths)
}

#[test]
fn semantic_merge_surfaces_fields_and_flags_the_conflict() {
    let (repo, _root, _paths) = conflicted_repo();
    let conflicts = merge::conflicts(&repo).unwrap();
    assert_eq!(conflicts.cases.len(), 1);
    let cm = &conflicts.cases[0];
    assert_eq!(cm.id, "TC-0007");
    assert!(cm.has_conflict);

    // Title: only ours changed -> auto, suggested ours, not a conflict.
    let title = cm.fields.iter().find(|f| f.key == "title").unwrap();
    assert!(!title.conflict);
    assert_eq!(title.suggested, Side::Ours);
    assert_eq!(title.ours.as_deref(), Some("Add item to cart"));

    // Priority: both sides changed differently -> genuine conflict.
    let pr = cm.fields.iter().find(|f| f.key == "priority").unwrap();
    assert!(pr.conflict);
    assert_eq!(pr.base.as_deref(), Some("medium"));
    assert_eq!(pr.ours.as_deref(), Some("high"));
    assert_eq!(pr.theirs.as_deref(), Some("critical"));
}

#[test]
fn resolving_writes_clean_file_and_clears_the_conflict() {
    let (_repo, _root, paths) = conflicted_repo();

    // Take theirs for priority; title auto-resolves to ours.
    let mut picks = BTreeMap::new();
    picks.insert("priority".to_string(), Side::Theirs);

    let merged = merge::resolve_case(&paths, "testhound/suites/checkout/cases/TC-0007-add.md", &picks)
        .unwrap();
    assert_eq!(merged.front.title, "Add item to cart");
    assert_eq!(merged.front.priority, Priority::Critical);

    // The file on disk parses cleanly (no conflict markers) and the index
    // conflict is gone.
    let reloaded = repo::load_case(&paths, "TC-0007").unwrap();
    assert_eq!(reloaded.front.priority, Priority::Critical);
    assert!(!reloaded.body.contains("<<<<<<<"));

    let fresh = Repository::open(&paths.root).unwrap();
    assert!(!fresh.index().unwrap().has_conflicts());
}

#[test]
fn id_collisions_detected_and_renumber_relinks() {
    let (_repo, root, paths) = tmp_repo_scaffolded();

    // Two files claiming the same id -> collision.
    write_case(&root, "TC-0007-add.md", &case_file("Add to cart", "high"));
    write_case(&root, "TC-0007-dup.md", &case_file("Duplicate case", "low"));

    let collisions = merge::detect_id_collisions(&paths).unwrap();
    assert_eq!(collisions.len(), 1);
    assert_eq!(collisions[0].id, "TC-0007");
    assert_eq!(collisions[0].paths.len(), 2);

    let new_id = merge::renumber_case(&paths, "testhound/suites/checkout/cases/TC-0007-dup.md")
        .unwrap();
    assert_ne!(new_id, "TC-0007");

    // After renumber the collision is resolved and both cases load.
    let after = merge::detect_id_collisions(&paths).unwrap();
    assert!(after.is_empty());
    assert!(repo::load_case(&paths, &new_id).is_ok());
    assert!(repo::load_case(&paths, "TC-0007").is_ok());
}

fn tmp_repo_scaffolded() -> (Repository, PathBuf, Paths) {
    let (repo, root) = tmp_repo();
    let paths = Paths::new(&root, "testhound");
    repo::scaffold(&root, "Acme Shop", "testhound").unwrap();
    (repo, root, paths)
}
