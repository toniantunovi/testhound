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
