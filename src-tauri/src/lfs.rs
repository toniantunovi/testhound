//! Opt-in Git LFS tracking for large binary evidence (docs/04-git-storage.md
//! §4.9). By default TestHound gitignores heavy traces/videos and keeps only a
//! pointer, but a team can choose to version the evidence they care about via
//! Git LFS. We manage a clearly-delimited block in the repo's `.gitattributes`
//! so enabling/disabling is reversible and never disturbs the user's own rules.

use crate::error::Result;
use crate::repo::Paths;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

const BEGIN: &str = "# >>> testhound evidence (Git LFS) >>>";
const END: &str = "# <<< testhound evidence (Git LFS) <<<";

/// Glob patterns TestHound tracks with LFS when evidence versioning is enabled:
/// Playwright's output tree plus the common heavy artifact types.
pub const EVIDENCE_PATTERNS: &[&str] = &[
    "test-results/**",
    "**/*.webm",
    "**/*.mp4",
    "**/*.zip",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// The `git-lfs` binary is installed and on PATH.
    pub lfs_available: bool,
    /// TestHound's managed evidence block is present in `.gitattributes`.
    pub enabled: bool,
    /// The evidence globs TestHound would track.
    pub patterns: Vec<String>,
}

fn gitattributes(paths: &Paths) -> std::path::PathBuf {
    paths.root.join(".gitattributes")
}

fn lfs_available() -> bool {
    Command::new("git")
        .args(["lfs", "version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True if the managed block is present in `.gitattributes`.
fn block_present(text: &str) -> bool {
    text.contains(BEGIN)
}

/// Return `text` with the managed evidence block appended (idempotent).
fn with_block(text: &str) -> String {
    if block_present(text) {
        return text.to_string();
    }
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(BEGIN);
    out.push('\n');
    for p in EVIDENCE_PATTERNS {
        out.push_str(&format!("{p} filter=lfs diff=lfs merge=lfs -text\n"));
    }
    out.push_str(END);
    out.push('\n');
    out
}

/// Return `text` with the managed evidence block removed (idempotent).
fn without_block(text: &str) -> String {
    if !block_present(text) {
        return text.to_string();
    }
    let mut out = String::new();
    let mut skip = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == BEGIN {
            skip = true;
            continue;
        }
        if trimmed == END {
            skip = false;
            continue;
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    // Collapse a trailing run of blank lines the block may have left behind.
    while out.ends_with("\n\n") {
        out.pop();
    }
    out
}

pub fn status(paths: &Paths) -> Result<LfsStatus> {
    let text = std::fs::read_to_string(gitattributes(paths)).unwrap_or_default();
    Ok(LfsStatus {
        lfs_available: lfs_available(),
        enabled: block_present(&text),
        patterns: EVIDENCE_PATTERNS.iter().map(|s| s.to_string()).collect(),
    })
}

/// Enable evidence versioning: write the managed `.gitattributes` block and, if
/// the `git-lfs` binary is available, install the LFS filters in this repo.
pub fn enable(paths: &Paths) -> Result<LfsStatus> {
    let path = gitattributes(paths);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, with_block(&text))?;
    if lfs_available() {
        // Configure the smudge/clean filters for this repo. Best-effort: the
        // attributes are what drive tracking; failure here just means the user
        // needs to run `git lfs install` themselves.
        let _ = run_git_lfs(&paths.root, &["install", "--local"]);
    }
    status(paths)
}

/// Disable evidence versioning by removing the managed block. Already-committed
/// LFS objects are left untouched; this only stops future files from being
/// tracked.
pub fn disable(paths: &Paths) -> Result<LfsStatus> {
    let path = gitattributes(paths);
    if let Ok(text) = std::fs::read_to_string(&path) {
        std::fs::write(&path, without_block(&text))?;
    }
    status(paths)
}

fn run_git_lfs(root: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git")
        .arg("lfs")
        .args(args)
        .current_dir(root)
        .output()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_and_removes_block_idempotently() {
        let original = "*.rs text\n";
        let added = with_block(original);
        assert!(added.contains(BEGIN));
        assert!(added.contains("test-results/** filter=lfs"));
        assert!(added.starts_with("*.rs text"));
        // Idempotent add.
        assert_eq!(with_block(&added), added);

        let removed = without_block(&added);
        assert!(!removed.contains(BEGIN));
        assert!(!removed.contains("filter=lfs"));
        assert!(removed.contains("*.rs text"));
        // Idempotent remove.
        assert_eq!(without_block(&removed), removed);
    }

    #[test]
    fn round_trip_preserves_user_rules() {
        let original = "*.rs text\n*.png binary\n";
        let round = without_block(&with_block(original));
        assert!(round.contains("*.rs text"));
        assert!(round.contains("*.png binary"));
    }

    #[test]
    fn empty_gitattributes_gets_clean_block() {
        let added = with_block("");
        assert!(added.starts_with(BEGIN));
        assert!(added.trim_end().ends_with(END));
    }
}
