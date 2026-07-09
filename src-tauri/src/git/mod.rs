//! Git operations. Read-side status/branch/diff via `git2` (libgit2);
//! auth-sensitive network operations (clone/push/pull) shell out to the `git`
//! binary so the user's existing credential helpers are reused
//! (docs/02-architecture.md §2.2, docs/04-git-storage.md §4.5).

use crate::error::{Error, Result};
use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Short status code: "M", "A", "D", "R", "??".
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
    pub clean: bool,
    pub changed: Vec<ChangedFile>,
    pub detached: bool,
}

pub fn open(path: &Path) -> Result<Repository> {
    Repository::discover(path).map_err(|_| Error::NotAGitRepo(path.display().to_string()))
}

/// True if `path` is inside a Git working tree.
pub fn is_repo(path: &Path) -> bool {
    Repository::discover(path).is_ok()
}

pub fn current_branch(repo: &Repository) -> Result<String> {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok("(no commits yet)".to_string()),
    };
    if head.is_branch() {
        Ok(head.shorthand().unwrap_or("HEAD").to_string())
    } else {
        // Detached: show the short commit id.
        let oid = head.target();
        Ok(oid
            .map(|o| format!("detached@{:.7}", o))
            .unwrap_or_else(|| "HEAD".to_string()))
    }
}

fn ahead_behind(repo: &Repository) -> (usize, usize) {
    let local = match repo.head().ok().and_then(|h| h.target()) {
        Some(o) => o,
        None => return (0, 0),
    };
    let upstream = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
        .and_then(|name| {
            repo.find_branch(&name, git2::BranchType::Local)
                .ok()
                .and_then(|b| b.upstream().ok())
                .and_then(|u| u.get().target())
        });
    match upstream {
        Some(up) => repo.graph_ahead_behind(local, up).unwrap_or((0, 0)),
        None => (0, 0),
    }
}

pub fn status(repo: &Repository) -> Result<GitStatus> {
    let branch = current_branch(repo)?;
    let detached = repo.head_detached().unwrap_or(false);
    let (ahead, behind) = ahead_behind(repo);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut changed = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        if s.is_ignored() {
            continue;
        }
        let path = entry.path().unwrap_or("").to_string();
        let (code, staged) = classify(s);
        if code.is_empty() {
            continue;
        }
        changed.push(ChangedFile {
            path,
            status: code,
            staged,
        });
    }
    changed.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(GitStatus {
        branch,
        ahead,
        behind,
        clean: changed.is_empty(),
        changed,
        detached,
    })
}

fn classify(s: git2::Status) -> (String, bool) {
    use git2::Status as St;
    if s.contains(St::WT_NEW) {
        return ("??".into(), false);
    }
    if s.contains(St::INDEX_NEW) {
        return ("A".into(), true);
    }
    let staged = s.intersects(
        St::INDEX_MODIFIED | St::INDEX_DELETED | St::INDEX_RENAMED | St::INDEX_TYPECHANGE,
    );
    if s.intersects(St::WT_DELETED | St::INDEX_DELETED) {
        return ("D".into(), staged);
    }
    if s.intersects(St::WT_RENAMED | St::INDEX_RENAMED) {
        return ("R".into(), staged);
    }
    if s.intersects(St::WT_MODIFIED | St::INDEX_MODIFIED | St::WT_TYPECHANGE | St::INDEX_TYPECHANGE)
    {
        return ("M".into(), staged);
    }
    (String::new(), false)
}

pub fn branches(repo: &Repository) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for b in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = b?;
        if let Some(name) = branch.name()? {
            out.push(name.to_string());
        }
    }
    out.sort();
    Ok(out)
}

pub fn checkout_branch(repo: &Repository, name: &str) -> Result<()> {
    let (object, reference) = repo.revparse_ext(name)?;
    repo.checkout_tree(&object, None)?;
    match reference {
        Some(r) => repo.set_head(r.name().unwrap_or(name))?,
        None => repo.set_head_detached(object.id())?,
    }
    Ok(())
}

/// Read a repo-relative file's contents as of `HEAD`, or `None` if the path is
/// untracked (new file) or HEAD has no commit yet. Used to diff a generated or
/// edited spec against its committed version.
pub fn read_head_file(repo: &Repository, rel: &str) -> Option<String> {
    let tree = repo.head().ok()?.peel_to_tree().ok()?;
    let entry = tree.get_path(Path::new(rel)).ok()?;
    let object = entry.to_object(repo).ok()?;
    let blob = object.as_blob()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

/// Clone via the `git` binary to reuse the user's credential helpers.
pub fn clone(url: &str, dest: &Path) -> Result<()> {
    let out = Command::new("git")
        .arg("clone")
        .arg(url)
        .arg(dest)
        .output()
        .map_err(|e| Error::Other(format!("failed to spawn git: {e}")))?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Initialize a new Git repository at `path` if one does not exist.
pub fn init_if_needed(path: &Path) -> Result<()> {
    if !is_repo(path) {
        Repository::init(path)?;
    }
    Ok(())
}

// ---- History, diff & blame (read-side, via git2) ------------------------------

/// A single commit touching a file, for the Case History timeline.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    /// Author date as an RFC3339 string, so the UI's relative-time helper works.
    pub when: String,
    pub message: String,
    pub summary: String,
}

/// One line's provenance, for the blame annotation column.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: usize,
    pub short: String,
    pub author: String,
}

fn iso(secs: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

fn commit_info(commit: &git2::Commit) -> CommitInfo {
    let author = commit.author();
    CommitInfo {
        hash: commit.id().to_string(),
        short: format!("{:.7}", commit.id()),
        author: author.name().unwrap_or("unknown").to_string(),
        email: author.email().unwrap_or("").to_string(),
        when: iso(author.when().seconds()),
        message: commit.message().unwrap_or("").to_string(),
        summary: commit.summary().unwrap_or("").to_string(),
    }
}

/// Did `commit` change `rel` relative to any parent (or introduce it, for a
/// root commit)?
fn commit_touched(repo: &Repository, commit: &git2::Commit, rel: &str) -> Result<bool> {
    let tree = commit.tree()?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(rel);
    if commit.parent_count() == 0 {
        let diff = repo.diff_tree_to_tree(None, Some(&tree), Some(&mut opts))?;
        return Ok(diff.deltas().len() > 0);
    }
    for i in 0..commit.parent_count() {
        let parent = commit.parent(i)?;
        let diff =
            repo.diff_tree_to_tree(Some(&parent.tree()?), Some(&tree), Some(&mut opts))?;
        if diff.deltas().len() > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The commits that touched `rel`, newest first, capped at `limit`.
pub fn log_for_path(repo: &Repository, rel: &str, limit: usize) -> Result<Vec<CommitInfo>> {
    if repo.head().is_err() {
        return Ok(Vec::new());
    }
    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(git2::Sort::TIME)?;

    let mut out = Vec::new();
    for oid in walk {
        let commit = repo.find_commit(oid?)?;
        if commit_touched(repo, &commit, rel)? {
            out.push(commit_info(&commit));
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

fn read_from_tree(repo: &Repository, tree: &git2::Tree, rel: &str) -> Option<String> {
    let entry = tree.get_path(Path::new(rel)).ok()?;
    let blob = entry.to_object(repo).ok()?;
    let blob = blob.as_blob()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

/// Metadata for a single commit by hash.
pub fn commit_meta(repo: &Repository, hash: &str) -> Result<CommitInfo> {
    let commit = repo.find_commit(git2::Oid::from_str(hash)?)?;
    Ok(commit_info(&commit))
}

/// `rel`'s contents as of `hash`, or `None` if it did not exist there.
pub fn file_at_commit(repo: &Repository, rel: &str, hash: &str) -> Result<Option<String>> {
    let commit = repo.find_commit(git2::Oid::from_str(hash)?)?;
    Ok(read_from_tree(repo, &commit.tree()?, rel))
}

/// `rel`'s contents as of `hash`'s first parent, i.e. the "before" side of the
/// commit's diff. `None` for a root commit or when the file was added there.
pub fn file_before_commit(repo: &Repository, rel: &str, hash: &str) -> Result<Option<String>> {
    let commit = repo.find_commit(git2::Oid::from_str(hash)?)?;
    if commit.parent_count() == 0 {
        return Ok(None);
    }
    let parent = commit.parent(0)?;
    Ok(read_from_tree(repo, &parent.tree()?, rel))
}

/// Per-line blame for the working-tree version of `rel`.
pub fn blame_file(repo: &Repository, rel: &str) -> Result<Vec<BlameLine>> {
    let blame = repo.blame_file(Path::new(rel), None)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::Other("bare repository has no working tree".into()))?;
    let content = std::fs::read_to_string(workdir.join(rel)).unwrap_or_default();

    let mut out = Vec::new();
    for (i, _) in content.lines().enumerate() {
        let lineno = i + 1;
        match blame.get_line(lineno) {
            Some(hunk) => out.push(BlameLine {
                line: lineno,
                short: format!("{:.7}", hunk.final_commit_id()),
                author: hunk
                    .final_signature()
                    .name()
                    .unwrap_or("")
                    .to_string(),
            }),
            None => out.push(BlameLine {
                line: lineno,
                short: String::new(),
                author: String::new(),
            }),
        }
    }
    Ok(out)
}

// ---- Staging, commit & sync (via the `git` binary) ----------------------------
// These reuse the user's Git identity, hooks, and credential helpers, matching
// the clone path above (docs/02-architecture.md §2.2).

fn run_git(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| Error::Other(format!("failed to spawn git: {e}")))?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "git {}: {}",
            args.first().copied().unwrap_or(""),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Stage exactly `files` (repo-relative) and commit them with `message`.
pub fn commit_paths(root: &Path, message: &str, files: &[String]) -> Result<()> {
    if files.is_empty() {
        return Err(Error::Other("no files selected to commit".into()));
    }
    let mut add: Vec<&str> = vec!["add", "--"];
    add.extend(files.iter().map(String::as_str));
    run_git(root, &add)?;
    run_git(root, &["commit", "-m", message])?;
    Ok(())
}

/// Push the current branch to its upstream.
pub fn push(root: &Path) -> Result<String> {
    let out = Command::new("git")
        .current_dir(root)
        .arg("push")
        .output()
        .map_err(|e| Error::Other(format!("failed to spawn git: {e}")))?;
    // `git push` writes its progress to stderr even on success.
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        return Err(Error::Other(format!("git push: {}", text.trim())));
    }
    Ok(text.trim().to_string())
}

/// Fast-forward pull then push, returning a combined human-readable log. Never
/// destructive: `--ff-only` refuses to create a merge, so a diverged branch is
/// reported rather than silently merged.
pub fn sync(root: &Path) -> Result<String> {
    let mut log = String::new();
    for step in [
        ("pull", vec!["pull", "--ff-only"]),
        ("push", vec!["push"]),
    ] {
        let out = Command::new("git")
            .current_dir(root)
            .args(&step.1)
            .output()
            .map_err(|e| Error::Other(format!("failed to spawn git: {e}")))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
        log.push_str(&format!("$ git {}\n{}\n", step.1.join(" "), text.trim()));
    }
    Ok(log.trim().to_string())
}
