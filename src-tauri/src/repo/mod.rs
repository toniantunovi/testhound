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
use serde::Serialize;
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
    pub priority: Priority,
    #[serde(rename = "type")]
    pub kind: CaseType,
    pub status: CaseStatus,
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub automation_state: AutomationState,
    pub updated: Option<String>,
    /// Repo-relative path to the file, for Git operations and display.
    pub path: String,
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
        let suite: Suite = serde_yaml::from_str(&fs::read_to_string(&suite_yml)?)?;

        // sections
        let mut sections = Vec::new();
        let sections_dir = dir.join("sections");
        if sections_dir.is_dir() {
            for s in fs::read_dir(&sections_dir)? {
                let p = s?.path();
                if p.extension().and_then(|e| e.to_str()) == Some("yml") {
                    let section: Section = serde_yaml::from_str(&fs::read_to_string(&p)?)?;
                    sections.push(section);
                }
            }
            sections.sort_by_key(|s| s.order);
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
        let (fm, _body) = case_file::split_front_matter(&content);
        let Some(fm) = fm else { continue };
        let front: FrontMatter = match serde_yaml::from_str(fm) {
            Ok(f) => f,
            Err(_) => continue, // skip malformed files rather than failing the whole list
        };
        let rel = p
            .strip_prefix(&paths.root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(CaseSummary {
            id: front.id,
            title: front.title,
            suite: front.suite,
            section: front.section,
            priority: front.priority,
            kind: front.kind,
            status: front.status,
            owner: front.owner,
            tags: front.tags,
            automation_state: front.automation.state,
            updated: front.updated,
            path: rel,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
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
