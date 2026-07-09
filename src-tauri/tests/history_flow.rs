//! Exercises the M6 Git history/diff read-side and the commit path: two commits
//! touch a case file, and TestHound reads the timeline, the per-commit before/
//! after contents, blame, and a fresh commit of a working-tree edit.

use std::path::{Path, PathBuf};
use git2::{Repository, Signature};
use testhound_lib::git;
use testhound_lib::repo;

fn tmp_repo() -> (Repository, PathBuf) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir().join(format!(
        "testhound-history-{}-{}-{}",
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

fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Priya", "priya@example.com").unwrap();
    let parents: Vec<git2::Commit> = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|o| repo.find_commit(o).ok())
        .into_iter()
        .collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
        .unwrap()
}

const REL: &str = "testhound/suites/checkout/cases/TC-0007-add.md";

fn case_file(expected: &str) -> String {
    format!(
        "---\nid: TC-0007\ntitle: Add to cart\nsuite: checkout\npriority: high\ntype: functional\nstatus: active\n---\n\n## Steps\n1. Open the cart\n   - **Expected:** {expected}\n"
    )
}

fn write_case(root: &Path, content: &str) {
    let dir = root.join("testhound/suites/checkout/cases");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("TC-0007-add.md"), content).unwrap();
}

#[test]
fn history_diff_blame_and_commit() {
    let (repo, root) = tmp_repo();
    repo::scaffold(&root, "Acme Shop", "testhound").unwrap();

    write_case(&root, &case_file("Item added"));
    commit_all(&repo, "test(cart): initial add-to-cart case");
    write_case(&root, &case_file("Cart badge increments to 1"));
    let latest = commit_all(&repo, "test(cart): tighten expected results");
    let latest_hash = latest.to_string();

    // Timeline: two commits touched the case, newest first.
    let log = git::log_for_path(&repo, REL, 100).unwrap();
    assert_eq!(log.len(), 2, "both commits touched the case");
    assert_eq!(log[0].hash, latest_hash);
    assert!(log[0].summary.contains("tighten"));
    assert_eq!(log[0].author, "Priya");
    assert!(log[1].summary.contains("initial"));

    // Before/after contents of the latest commit.
    let after = git::file_at_commit(&repo, REL, &latest_hash).unwrap().unwrap();
    assert!(after.contains("Cart badge increments to 1"));
    let before = git::file_before_commit(&repo, REL, &latest_hash)
        .unwrap()
        .unwrap();
    assert!(before.contains("Item added"));
    assert!(!before.contains("Cart badge"));

    // commit_meta resolves the same commit by hash.
    let meta = git::commit_meta(&repo, &latest_hash).unwrap();
    assert_eq!(meta.short, latest_hash[..7]);

    // Blame covers every line of the working-tree file.
    let blame = git::blame_file(&repo, REL).unwrap();
    assert_eq!(blame.len(), case_file("Cart badge increments to 1").lines().count());
    assert!(blame.iter().all(|b| b.author == "Priya"));

    // A working-tree edit committed via the git binary lands as a new commit.
    // (Set a local identity so `git commit` succeeds in a clean environment.)
    std::process::Command::new("git")
        .current_dir(&root)
        .args(["config", "user.email", "t@example.com"])
        .status()
        .unwrap();
    std::process::Command::new("git")
        .current_dir(&root)
        .args(["config", "user.name", "Tester"])
        .status()
        .unwrap();

    write_case(&root, &case_file("Cart badge increments to 1 and toast appears"));
    git::commit_paths(&root, "test(cart): add toast expectation", &[REL.to_string()]).unwrap();

    let log2 = git::log_for_path(&repo, REL, 100).unwrap();
    assert_eq!(log2.len(), 3, "the committed edit adds a third entry");
    assert!(log2[0].summary.contains("toast"));
}
