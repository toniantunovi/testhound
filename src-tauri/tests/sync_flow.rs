//! End-to-end exercise of the Sync flow against a real bare remote: the
//! fast-forward happy path, a diverged branch (Sync reports, the user opts
//! into a merge), a conflicted merge resolved semantically and concluded via
//! `complete_merge`, and uncommitted changes that conflict with a pull
//! (autostash kept aside, re-applied with `stash_pop`).

use std::path::{Path, PathBuf};
use testhound_lib::git::{self, SyncStatus};
use testhound_lib::merge::{self, Side};
use testhound_lib::repo::Paths;

fn tmp_dir(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir().join(format!(
        "testhound-sync-{tag}-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&base).unwrap();
    base
}

fn sh(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn config_identity(dir: &Path) {
    sh(dir, &["config", "user.email", "t@example.com"]);
    sh(dir, &["config", "user.name", "Tester"]);
}

const REL: &str = "testhound/suites/checkout/cases/TC-0007-add.md";

fn case_file(title: &str) -> String {
    format!(
        "---\nid: TC-0007\ntitle: {title}\nsuite: checkout\npriority: high\ntype: functional\nstatus: active\n---\n\n## Steps\n1. Open the cart\n   - **Expected:** Cart is shown\n"
    )
}

fn write_case(root: &Path, content: &str) {
    let dir = root.join("testhound/suites/checkout/cases");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("TC-0007-add.md"), content).unwrap();
}

/// A bare remote plus two clones ("ours" and "peer") sharing one initial commit.
fn setup() -> (PathBuf, PathBuf) {
    let remote = tmp_dir("remote");
    sh(&remote, &["init", "--bare", "-b", "main"]);

    let ours = tmp_dir("ours");
    sh(&ours, &["init", "-b", "main"]);
    config_identity(&ours);
    sh(&ours, &["remote", "add", "origin", remote.to_str().unwrap()]);
    write_case(&ours, &case_file("Add to cart"));
    sh(&ours, &["add", "."]);
    sh(&ours, &["commit", "-m", "initial"]);
    sh(&ours, &["push", "-u", "origin", "main"]);

    let peer = tmp_dir("peer");
    sh(&peer, &["clone", remote.to_str().unwrap(), "."]);
    config_identity(&peer);

    (ours, peer)
}

/// The peer pushes an edit to the shared case file.
fn peer_pushes(peer: &Path, title: &str) {
    write_case(peer, &case_file(title));
    sh(peer, &["add", "."]);
    sh(peer, &["commit", "-m", "peer edit"]);
    sh(peer, &["push"]);
}

/// A branch created in-app has no upstream. Push must publish it and set the
/// upstream so it works even without the user's `push.autoSetupRemote` config.
#[test]
fn push_publishes_a_new_branch_without_autosetup() {
    let (ours, _peer) = setup();
    // Simulate the default git config where a bare push has no upstream fallback.
    sh(&ours, &["config", "push.autoSetupRemote", "false"]);

    let repo = git::open(&ours).unwrap();
    git::create_branch(&repo, "feature/new-cases").unwrap();
    drop(repo);

    // First push of the new branch: it has no upstream yet.
    git::push(&ours).unwrap();

    // The branch now tracks the remote and is in sync.
    let repo = git::open(&ours).unwrap();
    let branch = repo
        .find_branch("feature/new-cases", git2::BranchType::Local)
        .unwrap();
    assert!(
        branch.upstream().is_ok(),
        "upstream should be set after the first push"
    );
    let status = git::status(&repo).unwrap();
    assert_eq!(status.branch, "feature/new-cases");
    assert_eq!((status.ahead, status.behind), (0, 0));

    // A subsequent push (now with an upstream) still succeeds.
    write_case(&ours, &case_file("Add to cart (on branch)"));
    sh(&ours, &["add", "."]);
    sh(&ours, &["commit", "-m", "branch edit"]);
    git::push(&ours).unwrap();
    let repo = git::open(&ours).unwrap();
    assert_eq!(git::status(&repo).unwrap().ahead, 0, "second push landed");
}

#[test]
fn sync_fast_forwards_when_behind() {
    let (ours, peer) = setup();
    peer_pushes(&peer, "Add to cart quickly");

    let out = git::sync(&ours).unwrap();
    assert_eq!(out.status, SyncStatus::Ok, "log: {}", out.log);

    let repo = git::open(&ours).unwrap();
    let status = git::status(&repo).unwrap();
    assert_eq!((status.ahead, status.behind), (0, 0));
    assert!(std::fs::read_to_string(ours.join(REL))
        .unwrap()
        .contains("quickly"));
}

#[test]
fn diverged_then_conflicted_merge_resolves_and_completes() {
    let (ours, peer) = setup();
    peer_pushes(&peer, "Add to cart (peer wording)");

    // Our side commits a different edit to the same file: diverged.
    write_case(&ours, &case_file("Add to cart (our wording)"));
    sh(&ours, &["add", "."]);
    sh(&ours, &["commit", "-m", "our edit"]);

    // Sync refuses to merge silently and reports the divergence.
    let out = git::sync(&ours).unwrap();
    assert_eq!(out.status, SyncStatus::Diverged, "log: {}", out.log);

    // The user opts in; the merge stops on the conflicted case file.
    let out = git::merge_remote(&ours).unwrap();
    assert_eq!(out.status, SyncStatus::Conflicts, "log: {}", out.log);
    assert_eq!(out.conflict_count, 1);

    // The Merge view sees the in-progress merge and a semantic case conflict.
    let repo = git::open(&ours).unwrap();
    let conflicts = merge::conflicts(&repo).unwrap();
    assert!(conflicts.merging);
    assert_eq!(conflicts.cases.len(), 1);
    assert!(conflicts.cases[0].has_conflict);

    // Resolve by keeping our side, then conclude: commit and push. Reopen the
    // repo per step, as each IPC command does; a held handle caches the index.
    let paths = Paths::new(&ours, "testhound");
    merge::resolve_keep(&paths, REL, Side::Ours).unwrap();
    let repo = git::open(&ours).unwrap();
    let conflicts = merge::conflicts(&repo).unwrap();
    assert!(conflicts.merging, "merge still open until the commit");
    assert!(conflicts.cases.is_empty());

    let log = git::complete_merge(&ours).unwrap();
    assert!(log.contains("git commit"), "log: {log}");

    let repo = git::open(&ours).unwrap();
    let conflicts = merge::conflicts(&repo).unwrap();
    assert!(!conflicts.merging);
    let status = git::status(&repo).unwrap();
    assert_eq!((status.ahead, status.behind), (0, 0), "merge commit pushed");
    assert!(std::fs::read_to_string(ours.join(REL))
        .unwrap()
        .contains("our wording"));
}

#[test]
fn dirty_pull_keeps_changes_in_stash_and_stash_pop_surfaces_conflicts() {
    let (ours, peer) = setup();
    peer_pushes(&peer, "Add to cart (peer wording)");

    // Uncommitted local edit to the same lines the peer changed.
    write_case(&ours, &case_file("Add to cart (uncommitted wording)"));

    // The pull fast-forwards; the autostash conflicts and is kept aside.
    let out = git::sync(&ours).unwrap();
    assert_eq!(out.status, SyncStatus::StashConflicts, "log: {}", out.log);
    assert!(std::fs::read_to_string(ours.join(REL))
        .unwrap()
        .contains("peer wording"));

    // Re-applying surfaces the conflict in the index for the Merge view.
    let out = git::stash_pop(&ours).unwrap();
    assert_eq!(out.status, SyncStatus::Conflicts, "log: {}", out.log);
    assert_eq!(out.conflict_count, 1);

    let repo = git::open(&ours).unwrap();
    let conflicts = merge::conflicts(&repo).unwrap();
    assert!(!conflicts.merging, "stash conflicts are not a merge state");
    assert_eq!(conflicts.cases.len(), 1);

    // Resolving works the same as for a merge conflict. Note git's stash-apply
    // sides: "ours" is the pulled commit, "theirs" is the stashed local edit.
    let paths = Paths::new(&ours, "testhound");
    merge::resolve_keep(&paths, REL, Side::Theirs).unwrap();
    let repo = git::open(&ours).unwrap();
    assert!(merge::conflicts(&repo).unwrap().cases.is_empty());
    assert!(std::fs::read_to_string(ours.join(REL))
        .unwrap()
        .contains("uncommitted wording"));
}
