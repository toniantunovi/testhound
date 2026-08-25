//! On-disk repository format: serialization of domain entities to/from files,
//! plus scaffolding and loading of a `testhound/` directory.
//!
//! The repository *is* the database (docs/04-git-storage.md). Everything here
//! reads and writes human-readable, diff-friendly files.

pub mod case_file;
pub mod runs;

use crate::domain::{
    parse_body, Automation, AutomationState, CaseStatus, CaseType, FrontMatter, Priority, Project,
    Section, Suite, TestCase,
};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Resolved paths for an open project. `root` is the repo working tree; `th`
/// is the TestHound data directory inside it (e.g. `<root>/testhound`).
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    pub th: PathBuf,
}

impl Paths {
    pub fn new(repo_root: &Path, th_dir: &str) -> Self {
        Paths {
            root: repo_root.to_path_buf(),
            th: repo_root.join(th_dir),
        }
    }
    fn project_yml(&self) -> PathBuf {
        self.th.join("project.yml")
    }
    fn suites_dir(&self) -> PathBuf {
        self.th.join("suites")
    }
    fn runs_dir(&self) -> PathBuf {
        self.th.join("runs")
    }
    fn automation_dir(&self) -> PathBuf {
        self.th.join("automation")
    }
}

/// A lightweight case row for the list view: no body/steps, cheap to build.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseSummary {
    pub id: String,
    pub title: String,
    pub suite: String,
    pub section: Option<String>,
    /// Manual sort position within the suite/section; `None` when never reordered.
    pub order: Option<i64>,
    pub priority: Priority,
    #[serde(rename = "type")]
    pub kind: CaseType,
    pub status: CaseStatus,
    pub owner: Option<String>,
    pub tags: Vec<String>,
    /// External references (ticket ids, URLs). Carried in the list row so the
    /// case list and filter queries can search by reference.
    pub references: Vec<String>,
    pub automation_state: AutomationState,
    pub updated: Option<String>,
    /// Repo-relative path to the file, for Git operations and display.
    pub path: String,
    /// The file exists but its front matter could not be parsed. Such a case is
    /// surfaced as a diagnostic row (with best-effort salvaged fields) rather
    /// than dropped, so a malformed edit can never make a case silently vanish.
    #[serde(default)]
    pub broken: bool,
}

/// A suite with its sections and case count, for the tree in the list view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteTree {
    pub id: String,
    pub name: String,
    pub order: i64,
    pub case_count: usize,
    pub sections: Vec<Section>,
}

/// Does this repo already contain a TestHound project? Returns the `th` dir name.
pub fn detect(repo_root: &Path) -> Option<String> {
    for candidate in ["testhound"] {
        if repo_root.join(candidate).join("project.yml").is_file() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Create the `testhound/` layout with an empty project. Idempotent: existing
/// files are left untouched.
pub fn scaffold(repo_root: &Path, name: &str, th_dir: &str) -> Result<Project> {
    if !repo_root.is_dir() {
        return Err(Error::NotADirectory(repo_root.display().to_string()));
    }
    let paths = Paths::new(repo_root, th_dir);
    fs::create_dir_all(&paths.suites_dir())?;
    fs::create_dir_all(&paths.runs_dir())?;
    fs::create_dir_all(&paths.automation_dir())?;
    fs::create_dir_all(paths.th.join("milestones"))?;
    fs::create_dir_all(paths.th.join("configurations"))?;

    // Ensure the derived cache dir is gitignored.
    ensure_gitignore(repo_root, th_dir)?;

    // links.yml index of record.
    let links = paths.automation_dir().join("links.yml");
    if !links.exists() {
        fs::write(&links, "links: []\n")?;
    }

    // project.yml
    let project_path = paths.project_yml();
    if project_path.exists() {
        return load_project(&paths);
    }
    let mut project = Project::default();
    project.name = name.to_string();
    project.root = th_dir.to_string();
    save_project(&paths, &project)?;
    Ok(project)
}

fn ensure_gitignore(repo_root: &Path, th_dir: &str) -> Result<()> {
    let gi = repo_root.join(".gitignore");
    let entry = format!("{th_dir}/.testhound/");
    let current = fs::read_to_string(&gi).unwrap_or_default();
    if current.lines().any(|l| l.trim() == entry) {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# TestHound derived cache (rebuildable from files)\n");
    next.push_str(&entry);
    next.push('\n');
    fs::write(&gi, next)?;
    Ok(())
}

pub fn load_project(paths: &Paths) -> Result<Project> {
    let content = fs::read_to_string(paths.project_yml())
        .map_err(|_| Error::InvalidFormat("missing project.yml".into()))?;
    Ok(serde_yaml::from_str(&content)?)
}

pub fn save_project(paths: &Paths, project: &Project) -> Result<()> {
    fs::create_dir_all(&paths.th)?;
    let yaml = serde_yaml::to_string(project)?;
    fs::write(paths.project_yml(), yaml)?;
    Ok(())
}

/// List suites with their sections and case counts.
pub fn list_suites(paths: &Paths) -> Result<Vec<SuiteTree>> {
    let mut out = Vec::new();
    let suites_dir = paths.suites_dir();
    if !suites_dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(&suites_dir)? {
        let dir = entry?.path();
        if !dir.is_dir() {
            continue;
        }
        let suite_yml = dir.join("suite.yml");
        if !suite_yml.is_file() {
            continue;
        }
        let mut suite: Suite = serde_yaml::from_str(&fs::read_to_string(&suite_yml)?)?;
        // Every path is built from the id (`suites/<id>/`, `sections/<id>.yml`),
        // so the location wins over a contradicting `id:` field. Otherwise a
        // hand-written or agent-written file makes rename, delete, reorder and
        // move target a path that does not exist.
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            suite.id = name.to_string();
        }

        // sections
        let mut sections = Vec::new();
        let sections_dir = dir.join("sections");
        if sections_dir.is_dir() {
            for s in fs::read_dir(&sections_dir)? {
                let p = s?.path();
                if p.extension().and_then(|e| e.to_str()) != Some("yml") {
                    continue;
                }
                let Some(stem) = p.file_stem().and_then(|n| n.to_str()) else {
                    continue;
                };
                // A folder whose YAML will not parse is skipped rather than
                // failing the whole tree: its cases still show up under "No
                // folder", where the tree keeps cases with a missing folder.
                let Ok(mut section) = serde_yaml::from_str::<Section>(&fs::read_to_string(&p)?)
                else {
                    continue;
                };
                section.id = stem.to_string();
                sections.push(section);
            }
            sections.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        }

        // case count
        let cases_dir = dir.join("cases");
        let case_count = if cases_dir.is_dir() {
            fs::read_dir(&cases_dir)?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                .count()
        } else {
            0
        };

        out.push(SuiteTree {
            id: suite.id,
            name: suite.name,
            order: suite.order,
            case_count,
            sections,
        });
    }
    out.sort_by(|a, b| a.order.cmp(&b.order).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// List all case summaries across all suites (cheap: front matter only).
pub fn list_cases(paths: &Paths) -> Result<Vec<CaseSummary>> {
    let mut out = Vec::new();
    let suites_dir = paths.suites_dir();
    if !suites_dir.is_dir() {
        return Ok(out);
    }
    for entry in WalkDir::new(&suites_dir).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // Only files under a `cases/` directory.
        if !p.components().any(|c| c.as_os_str() == "cases") {
            continue;
        }
        let content = fs::read_to_string(p)?;
        let rel = p
            .strip_prefix(&paths.root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/");
        let (fm, _body) = case_file::split_front_matter(&content);
        // No front matter, or front matter that won't parse: surface a broken
        // row instead of dropping the case, so a bad edit can't make it vanish.
        let Some(fm) = fm else {
            out.push(broken_summary("", p, rel));
            continue;
        };
        let front: FrontMatter = match serde_yaml::from_str(fm) {
            Ok(f) => f,
            Err(_) => {
                out.push(broken_summary(fm, p, rel));
                continue;
            }
        };
        out.push(CaseSummary {
            id: front.id,
            title: front.title,
            suite: front.suite,
            section: front.section,
            order: front.order,
            priority: front.priority,
            kind: front.kind,
            status: front.status,
            owner: front.owner,
            tags: front.tags,
            references: front.references,
            automation_state: front.automation.state,
            updated: front.updated,
            path: rel,
            broken: false,
        });
    }
    // A stable, suite-independent baseline. The manual `order` is relative to a
    // single suite/section, so applying it here would interleave suites; the
    // caller sorts for display, where the suite and section order is known too
    // (see `sortCases` in src/lib/cases.ts).
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Build a diagnostic summary for a case file whose front matter is missing or
/// unparseable. Salvages what it can: the id/title/suite from a permissive YAML
/// read where possible, and the suite from the file's own path (which encodes
/// it as `suites/<suite>/cases/…`). Marked `broken` so the UI can flag it for
/// repair rather than the case disappearing from every list.
fn broken_summary(fm: &str, path: &Path, rel: String) -> CaseSummary {
    let val: serde_yaml::Value =
        serde_yaml::from_str(fm).unwrap_or(serde_yaml::Value::Null);
    let get = |k: &str| {
        val.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };

    // Suite is reliably recoverable from the path: `…/suites/<suite>/cases/…`.
    let suite = get("suite").or_else(|| {
        let parts: Vec<String> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        parts
            .iter()
            .position(|c| c == "suites")
            .and_then(|i| parts.get(i + 1).cloned())
    });

    let id = get("id").unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string()
    });

    CaseSummary {
        id,
        title: get("title").unwrap_or_else(|| "Unparseable front matter".to_string()),
        suite: suite.unwrap_or_default(),
        section: None,
        order: None,
        priority: Priority::default(),
        kind: CaseType::default(),
        status: CaseStatus::default(),
        owner: None,
        tags: vec![],
        references: vec![],
        automation_state: AutomationState::None,
        updated: None,
        path: rel,
        broken: true,
    }
}

fn case_path(paths: &Paths, id: &str) -> Result<PathBuf> {
    for entry in WalkDir::new(paths.suites_dir())
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with(&format!("{id}-")) || n == format!("{id}.md"))
            .unwrap_or(false)
        {
            return Ok(p.to_path_buf());
        }
    }
    Err(Error::CaseNotFound(id.to_string()))
}

pub fn load_case(paths: &Paths, id: &str) -> Result<TestCase> {
    let path = case_path(paths, id)?;
    let content = fs::read_to_string(&path)?;
    case_file::parse(&content)
}

/// Delete a case file from disk. Errors if no case with `id` exists. The change
/// is left uncommitted for the user to review.
pub fn delete_case(paths: &Paths, id: &str) -> Result<()> {
    let path = case_path(paths, id)?;
    fs::remove_file(&path)?;
    Ok(())
}

/// Write a case to disk, recomputing derived structure. Returns the saved case.
pub fn save_case(paths: &Paths, case: &TestCase) -> Result<TestCase> {
    let suite_dir = paths.suites_dir().join(&case.front.suite);
    let cases_dir = suite_dir.join("cases");
    fs::create_dir_all(&cases_dir)?;

    // Preserve an existing filename (keeps Git history) or make a new slug.
    let path = case_path(paths, &case.front.id).unwrap_or_else(|_| {
        let slug = slug::slugify(&case.front.title);
        cases_dir.join(format!("{}-{}.md", case.front.id, slug))
    });

    // Refresh drift state from the body before writing, so editing a linked
    // case flips its badge to "drifted" the moment it diverges from its spec.
    let mut case = case.clone();
    case_file::apply_drift(&mut case.front, &case.body);

    let serialized = case_file::serialize(&case)?;
    fs::write(&path, serialized)?;

    // Reparse from disk so derived fields (steps) reflect what was written.
    load_case(paths, &case.front.id)
}

/// Create a suite directory with metadata.
pub fn create_suite(paths: &Paths, suite: &Suite) -> Result<()> {
    let dir = paths.suites_dir().join(&suite.id);
    fs::create_dir_all(dir.join("cases"))?;
    let yaml = serde_yaml::to_string(suite)?;
    fs::write(dir.join("suite.yml"), yaml)?;
    Ok(())
}

/// Rename a suite's display name. The id and directory stay stable so case
/// front matter (`suite: <id>`) and Git history are untouched.
pub fn rename_suite(paths: &Paths, id: &str, name: &str) -> Result<()> {
    let yml = paths.suites_dir().join(id).join("suite.yml");
    let content =
        fs::read_to_string(&yml).map_err(|_| Error::Other(format!("suite not found: {id}")))?;
    let mut suite: Suite = serde_yaml::from_str(&content)?;
    suite.name = name.to_string();
    fs::write(&yml, serde_yaml::to_string(&suite)?)?;
    Ok(())
}

/// Delete a suite directory including all its cases. Returns the ids of the
/// cases that were removed with it so callers can clean up automation links.
/// The change is left uncommitted for the user to review.
pub fn delete_suite(paths: &Paths, id: &str) -> Result<Vec<String>> {
    let dir = paths.suites_dir().join(id);
    if !dir.join("suite.yml").is_file() {
        return Err(Error::Other(format!("suite not found: {id}")));
    }
    let removed = list_cases(paths)?
        .into_iter()
        .filter(|c| c.suite == id)
        .map(|c| c.id)
        .collect();
    fs::remove_dir_all(&dir)?;
    Ok(removed)
}

/// Create a section (a folder inside a suite): `suites/<suite>/sections/<id>.yml`.
/// Errors if the suite is missing or a section with that id already exists.
pub fn create_section(paths: &Paths, suite: &str, section: &Section) -> Result<()> {
    let dir = paths.suites_dir().join(suite);
    if !dir.join("suite.yml").is_file() {
        return Err(Error::Other(format!("suite not found: {suite}")));
    }
    let sections_dir = dir.join("sections");
    fs::create_dir_all(&sections_dir)?;
    let path = sections_dir.join(format!("{}.yml", section.id));
    if path.exists() {
        return Err(Error::Other(format!(
            "a folder \"{}\" already exists in this suite",
            section.name
        )));
    }
    fs::write(&path, serde_yaml::to_string(section)?)?;
    Ok(())
}

/// The `order` value for a new item appended after `existing`. Sparse (steps of
/// 10) so it keeps working after a reorder, which renumbers from 10 upwards.
/// Saturating: a hand-edited `order: 9223372036854775807` must not overflow.
pub fn next_order(existing: impl IntoIterator<Item = i64>) -> i64 {
    existing.into_iter().max().unwrap_or(0).saturating_add(10)
}

/// Resolve a requested order against the actual members of a group: the
/// requested ids first (deduplicated), then any member the caller did not
/// mention, in the order `members` arrives in (which callers pass already sorted
/// the way the group is displayed, so an unmentioned member keeps its place).
/// Errors on an id that is not a member, so a stale UI can never reorder
/// something into the wrong suite or folder.
fn resolved_order(members: Vec<String>, requested: &[String], scope: &str) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for id in requested {
        if !members.contains(id) {
            return Err(Error::Other(format!("{id} is not in {scope}")));
        }
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    let rest: Vec<String> = members.into_iter().filter(|m| !out.contains(m)).collect();
    out.extend(rest);
    Ok(out)
}

/// Persist a manual order for the suites, in the given sequence. Suites left out
/// of `ids` keep their relative position after the listed ones.
pub fn reorder_suites(paths: &Paths, ids: &[String]) -> Result<()> {
    let members = list_suites(paths)?.into_iter().map(|s| s.id).collect();
    for (i, id) in resolved_order(members, ids, "this project")?
        .iter()
        .enumerate()
    {
        let yml = paths.suites_dir().join(id).join("suite.yml");
        let mut suite: Suite = serde_yaml::from_str(&fs::read_to_string(&yml)?)?;
        let order = (i as i64 + 1) * 10;
        if suite.order != order {
            suite.order = order;
            fs::write(&yml, serde_yaml::to_string(&suite)?)?;
        }
    }
    Ok(())
}

/// Persist a manual order for the sections of one suite, in the given sequence.
pub fn reorder_sections(paths: &Paths, suite: &str, ids: &[String]) -> Result<()> {
    let sections_dir = paths.suites_dir().join(suite).join("sections");
    let members = list_suites(paths)?
        .into_iter()
        .find(|s| s.id == suite)
        .ok_or_else(|| Error::Other(format!("suite not found: {suite}")))?
        .sections
        .into_iter()
        .map(|s| s.id)
        .collect();
    for (i, id) in resolved_order(members, ids, suite)?.iter().enumerate() {
        let yml = sections_dir.join(format!("{id}.yml"));
        let mut section: Section = serde_yaml::from_str(&fs::read_to_string(&yml)?)?;
        let order = (i as i64 + 1) * 10;
        if section.order != order {
            section.order = order;
            fs::write(&yml, serde_yaml::to_string(&section)?)?;
        }
    }
    Ok(())
}

/// Persist a manual order for the cases of one suite/section, in the given
/// sequence. Cases left out keep their relative position (by id) after the
/// listed ones. Only files whose `order` actually changes are rewritten, so a
/// drag that lands where it started leaves the working tree clean.
pub fn reorder_cases(
    paths: &Paths,
    suite: &str,
    section: Option<&str>,
    ids: &[String],
) -> Result<()> {
    // No requested sequence means no requested change. Renumbering the whole
    // group here would dirty every file in it for nothing.
    if ids.is_empty() {
        return Ok(());
    }
    // Keep each case's own path from the listing rather than resolving it again
    // by id: a reorder must never write to a different file than the one it
    // counted. Broken cases are excluded: their front matter does not parse, so
    // there is nothing to write an order into.
    let mut group: Vec<(String, PathBuf, Option<i64>)> = list_cases(paths)?
        .into_iter()
        .filter(|c| !c.broken && c.suite == suite && c.section.as_deref() == section)
        .map(|c| (c.id, paths.root.join(&c.path), c.order))
        .collect();
    // Put the group in its current display order, so a member the caller did not
    // mention keeps its position rather than being renumbered into id order.
    group.sort_by(|a, b| {
        a.2.unwrap_or(i64::MAX)
            .cmp(&b.2.unwrap_or(i64::MAX))
            .then_with(|| a.0.cmp(&b.0))
    });
    let scope = match section {
        Some(s) => format!("{suite}/{s}"),
        None => suite.to_string(),
    };
    // Two files in one group can carry the same id (see `id_collisions`). Which
    // of them a position refers to is then undecidable, and guessing writes one
    // file twice while skipping the other, leaving two cases with the same order.
    // Refuse and let the user renumber the collision first.
    if let Some((id, _, _)) = group
        .iter()
        .enumerate()
        .find(|(i, (id, _, _))| group[..*i].iter().any(|(seen, _, _)| seen == id))
        .map(|(_, row)| row)
    {
        return Err(Error::Other(format!(
            "two cases in {scope} share the id {id}; renumber the duplicate before reordering"
        )));
    }
    let members = group.iter().map(|(id, _, _)| id.clone()).collect();
    for (i, id) in resolved_order(members, ids, &scope)?.iter().enumerate() {
        let Some((_, path, _)) = group.iter().find(|(cid, _, _)| cid == id) else {
            continue;
        };
        set_case_order(path, (i as i64 + 1) * 10)?;
    }
    Ok(())
}

/// Write a case file's `order` front-matter field, leaving the rest of the file
/// (and its name) untouched. A no-op when the value already matches, so a drag
/// that lands where it started does not dirty the working tree.
fn set_case_order(path: &Path, order: i64) -> Result<()> {
    let content = fs::read_to_string(path)?;
    if let Some(patched) = case_file::set_order(&content, order)? {
        fs::write(path, patched)?;
    }
    Ok(())
}

/// The front-matter fields a bulk edit can set, as the case list's selection bar
/// sends them; a `None` leaves that field as it is. Only closed-vocabulary
/// fields are offered: their values are bare words, so they can be written into
/// the file without quoting or reformatting anything around them.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CaseFields {
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default, rename = "type")]
    pub kind: Option<CaseType>,
    #[serde(default)]
    pub status: Option<CaseStatus>,
}

impl CaseFields {
    /// The edits to apply: the front-matter key, the word to write, and the keys
    /// a missing one may be inserted after, so a case that never carried the key
    /// gains it in the documented order (docs/03-data-model.md) rather than
    /// wherever it is convenient.
    fn edits(&self) -> Result<Vec<(&'static str, String, &'static [&'static str])>> {
        const AFTER_PRIORITY: &[&str] = &["order", "section", "suite"];
        const AFTER_TYPE: &[&str] = &["priority", "order", "section", "suite"];
        const AFTER_STATUS: &[&str] = &["type", "priority", "order", "section", "suite"];
        let mut edits: Vec<(&'static str, String, &'static [&'static str])> = vec![];
        if let Some(p) = &self.priority {
            edits.push(("priority", yaml_word(p)?, AFTER_PRIORITY));
        }
        if let Some(k) = &self.kind {
            edits.push(("type", yaml_word(k)?, AFTER_TYPE));
        }
        if let Some(st) = &self.status {
            edits.push(("status", yaml_word(st)?, AFTER_STATUS));
        }
        Ok(edits)
    }
}

/// A domain enum as the bare word it takes in front matter. Derived from the
/// same serde renaming the parser reads, so the two cannot drift apart.
fn yaml_word<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_yaml::to_string(value)?.trim().to_string())
}

/// Set the same front-matter fields on every one of `ids`, one file at a time.
/// Each file is edited line by line (see `case_file::set_scalar`), so a case
/// that already holds the value is left byte-for-byte alone and nothing else in
/// its front matter is reformatted. Returns the ids that actually changed.
///
/// A failure stops the batch where it is: the cases written before it keep their
/// new values rather than being rolled back, and the caller reports the error so
/// a partly applied change is never silent.
pub fn set_case_fields(paths: &Paths, ids: &[String], fields: &CaseFields) -> Result<Vec<String>> {
    let edits = fields.edits()?;
    if ids.is_empty() || edits.is_empty() {
        return Ok(vec![]);
    }
    // Take each case's path from the listing rather than resolving it by id
    // again, the way a reorder does: a bulk write must never land in a different
    // file than the one the list showed.
    let known = list_cases(paths)?;
    let mut changed = Vec::new();
    for id in ids {
        let mut matching = known.iter().filter(|c| &c.id == id);
        let case = matching
            .next()
            .ok_or_else(|| Error::CaseNotFound(id.clone()))?;
        // Two files can carry the same id (see `id_collisions`). Which of them
        // the user ticked is undecidable, and writing one while leaving the other
        // would show as a half-applied change.
        if matching.next().is_some() {
            return Err(Error::Other(format!(
                "two cases share the id {id}; renumber the duplicate first"
            )));
        }
        if case.broken {
            return Err(Error::Other(format!(
                "{id}'s front matter does not parse; fix the file before setting fields on it"
            )));
        }
        let path = paths.root.join(&case.path);
        let mut content = fs::read_to_string(&path)?;
        let mut touched = false;
        for (key, value, after) in &edits {
            if let Some(patched) = case_file::set_scalar(&content, key, value, after)? {
                content = patched;
                touched = true;
            }
        }
        if touched {
            fs::write(&path, &content)?;
            changed.push(id.clone());
        }
    }
    Ok(changed)
}

/// Rename a section's display name. The id (and thus the section filename and
/// the `section:` references in case front matter) stays stable so nothing has
/// to be rewritten. The change is left uncommitted for the user to review.
pub fn rename_section(paths: &Paths, suite: &str, id: &str, name: &str) -> Result<()> {
    let yml = paths
        .suites_dir()
        .join(suite)
        .join("sections")
        .join(format!("{id}.yml"));
    let content =
        fs::read_to_string(&yml).map_err(|_| Error::Other(format!("section not found: {id}")))?;
    let mut section: Section = serde_yaml::from_str(&content)?;
    section.name = name.to_string();
    fs::write(&yml, serde_yaml::to_string(&section)?)?;
    Ok(())
}

/// Delete a section from a suite. Removes the section file, detaches any child
/// sections (their `parent` is cleared so they don't reference a missing
/// section), and drops the `section:` assignment from every case that pointed
/// at it. The cases themselves are kept; only their section reference is
/// cleared. The change is left uncommitted for the user to review.
pub fn delete_section(paths: &Paths, suite: &str, id: &str) -> Result<()> {
    let sections_dir = paths.suites_dir().join(suite).join("sections");
    let yml = sections_dir.join(format!("{id}.yml"));
    if !yml.is_file() {
        return Err(Error::Other(format!("section not found: {id}")));
    }
    fs::remove_file(&yml)?;

    // Detach any child sections so they don't reference a now-missing parent.
    for entry in fs::read_dir(&sections_dir)? {
        let p = entry?.path();
        if p.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let mut section: Section = serde_yaml::from_str(&fs::read_to_string(&p)?)?;
        if section.parent.as_deref() == Some(id) {
            section.parent = None;
            fs::write(&p, serde_yaml::to_string(&section)?)?;
        }
    }

    // Drop the section assignment from any case that referenced it. Skip files
    // whose front matter won't parse rather than aborting the whole delete.
    let cases_dir = paths.suites_dir().join(suite).join("cases");
    if cases_dir.is_dir() {
        for entry in fs::read_dir(&cases_dir)? {
            let p = entry?.path();
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(mut case) = case_file::parse(&fs::read_to_string(&p)?) else {
                continue;
            };
            if case.front.section.as_deref() == Some(id) {
                case.front.section = None;
                fs::write(&p, case_file::serialize(&case)?)?;
            }
        }
    }
    Ok(())
}

/// Move a case into another suite and/or folder: rewrite `suite:`/`section:` in
/// the front matter and, when the suite changes, relocate the file, keeping its
/// filename so Git can detect the rename. Sections are metadata, not
/// directories, so a folder change rewrites the file in place. Any manual order
/// is dropped: the case lands at the end of its new group. Automation links key
/// on the case id and stay valid.
pub fn move_case(
    paths: &Paths,
    id: &str,
    suite: &str,
    section: Option<&str>,
) -> Result<TestCase> {
    let old_path = case_path(paths, id)?;
    let mut case = case_file::parse(&fs::read_to_string(&old_path)?)?;
    if case.front.suite == suite && case.front.section.as_deref() == section {
        return Ok(case);
    }
    let same_suite = case.front.suite == suite;
    case.front.suite = suite.to_string();
    case.front.section = section.map(str::to_string);
    case.front.order = None;
    if same_suite {
        fs::write(&old_path, case_file::serialize(&case)?)?;
        return load_case(paths, id);
    }
    let cases_dir = paths.suites_dir().join(suite).join("cases");
    fs::create_dir_all(&cases_dir)?;
    let file_name = old_path
        .file_name()
        .ok_or_else(|| Error::Other(format!("bad case path for {id}")))?
        .to_os_string();
    let new_path = cases_dir.join(&file_name);
    // Two files can carry the same id (see `id_collisions`), and they would want
    // the same file name here. Refuse rather than overwrite a case.
    if new_path.exists() {
        return Err(Error::Other(format!(
            "{suite} already has a file named {}; resolve the duplicate id first",
            file_name.to_string_lossy()
        )));
    }
    fs::write(&new_path, case_file::serialize(&case)?)?;
    fs::remove_file(&old_path)?;
    load_case(paths, id)
}

/// Duplicate a case under a fresh id, optionally into another suite. The copy
/// starts unautomated: it must not share the source's spec links.
pub fn duplicate_case(paths: &Paths, id: &str, suite: Option<&str>) -> Result<TestCase> {
    let source = load_case(paths, id)?;
    let mut copy = source.clone();
    copy.front.id = next_case_id(paths)?;
    copy.front.title = format!("{} (copy)", source.front.title);
    if let Some(s) = suite {
        copy.front.suite = s.to_string();
        copy.front.section = None;
    }
    copy.front.automation = Automation::default();
    // The copy lands at the end of its group rather than next to its source: a
    // shared order value would make the pair's relative position arbitrary.
    copy.front.order = None;
    copy.front.created = None;
    copy.front.updated = None;
    save_case(paths, &copy)
}

/// Allocate the next case id from `project.yml` and persist the increment.
pub fn next_case_id(paths: &Paths) -> Result<String> {
    let mut project = load_project(paths)?;
    let n = project.next_case_id.max(1);
    project.next_case_id = n + 1;
    save_project(paths, &project)?;
    Ok(format!("TC-{n:04}"))
}

/// Build a full `TestCase` with a freshly parsed body.
pub fn new_case(id: String, title: String, suite: String, body: &str) -> TestCase {
    let parsed = parse_body(body);
    TestCase {
        front: FrontMatter {
            id,
            title,
            suite,
            section: None,
            order: None,
            priority: Priority::default(),
            kind: CaseType::default(),
            status: CaseStatus::default(),
            owner: None,
            tags: vec![],
            references: vec![],
            estimate: None,
            automation: Automation::default(),
            custom: Default::default(),
            created: None,
            updated: None,
        },
        body: body.to_string(),
        steps: parsed.steps,
        preconditions: parsed.preconditions,
    }
}
