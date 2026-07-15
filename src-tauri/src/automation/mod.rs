//! AI automation core (docs/05-ai-automation.md, roadmap M4).
//!
//! This module holds the deterministic machinery around the coding agents:
//! building prompts from a manual case plus repo context, the `automation/`
//! index of record (`links.yml`), coverage aggregation, spec-file change
//! detection, and the accept flow that links a generated spec back to its case.
//! The agent subprocess itself lives in [`agent`]; everything here is pure or
//! plain filesystem work so it stays testable without a live agent install.

pub mod agent;

use crate::domain::{
    Automation, AutomationState, CaseStatus, Priority, TestCase,
};
use crate::error::Result;
use crate::playwright::{self, parse_spec_ref};
use crate::repo::{self, case_file, Paths};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use walkdir::WalkDir;

/// Current UTC timestamp in the `2026-07-09T09:14:03Z` style used on disk.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---- repo context -------------------------------------------------------------

/// What TestHound could learn about the project to make a generated spec fit in:
/// the Playwright config, the conventional tests dir, a detected base URL, and
/// nearby specs the agent should imitate / reuse fixtures from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoContext {
    pub config: Option<String>,
    pub tests_dir: String,
    pub base_url: Option<String>,
    pub nearby_specs: Vec<String>,
    /// The conventional path a new spec for this case should be written to.
    pub target_path: String,
}

/// Default location for a case's spec: `<tests_dir>/<suite>/<slug>.spec.ts`.
/// `tests_dir` is the project's Playwright `testDir` so generated specs land
/// where Playwright actually discovers them.
pub fn spec_path_for(case: &TestCase, tests_dir: &str) -> String {
    format!(
        "{}/{}/{}.spec.ts",
        tests_dir,
        case.front.suite,
        slug::slugify(&case.front.title)
    )
}

/// Inspect the repo to build [`RepoContext`] for a case.
pub fn detect_context(paths: &Paths, case: &TestCase) -> RepoContext {
    let pw = playwright::detect(&paths.root);
    // Respect the project's configured `testDir` (e.g. `./playwright`) so specs
    // are generated where Playwright looks; fall back to `tests`.
    let tests_dir = pw
        .config
        .as_deref()
        .and_then(|cfg| playwright::detect_test_dir(&paths.root.join(cfg)))
        .unwrap_or_else(|| "tests".to_string());
    // A configured test target wins over whatever is scraped from the config, so
    // generated specs point at the address the user set in Settings.
    let base_url = playwright::load_target(paths)
        .base_url
        .filter(|u| !u.trim().is_empty())
        .or_else(|| {
            pw.config
                .as_deref()
                .and_then(|cfg| detect_base_url(&paths.root.join(cfg)))
        });

    // Nearby specs: existing spec files under the suite's tests dir, capped.
    let suite_dir = paths.root.join(&tests_dir).join(&case.front.suite);
    let mut nearby: Vec<String> = spec_files_under(&suite_dir, &paths.root);
    nearby.truncate(8);

    RepoContext {
        config: pw.config,
        target_path: spec_path_for(case, &tests_dir),
        tests_dir,
        base_url,
        nearby_specs: nearby,
    }
}

/// Best-effort scrape of `baseURL: "…"` from a Playwright config.
fn detect_base_url(config: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config).ok()?;
    let idx = text.find("baseURL")?;
    let after = &text[idx + "baseURL".len()..];
    // Skip `:` and whitespace, then read the quoted value.
    let after = after.trim_start_matches([':', ' ', '\t']);
    let quote = after.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let rest = &after[1..];
    let end = rest.find(quote)?;
    let url = rest[..end].trim();
    (!url.is_empty()).then(|| url.to_string())
}

// ---- automation setup notes -----------------------------------------------------

/// The committed automation setup notes: how to start the app, environments,
/// test accounts (names only, never secrets), seeding, auth strategy, and
/// selector conventions. Fed to agents alongside the detected repo context.
fn setup_path(paths: &Paths) -> std::path::PathBuf {
    paths.th.join("automation").join("setup.md")
}

/// Load the setup notes, or an empty string if none have been written.
pub fn load_setup(paths: &Paths) -> String {
    std::fs::read_to_string(setup_path(paths)).unwrap_or_default()
}

/// Persist the setup notes. An empty document removes the file so the repo
/// stays clean.
pub fn save_setup(paths: &Paths, content: &str) -> Result<()> {
    let path = setup_path(paths);
    if content.trim().is_empty() {
        if path.is_file() {
            std::fs::remove_file(path)?;
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

// ---- prompt building ----------------------------------------------------------

/// Render a case's preconditions and steps into a compact, agent-friendly block.
fn render_case(case: &TestCase) -> String {
    let mut out = format!("Title: {}\nId: {}\n", case.front.title, case.front.id);
    if !case.preconditions.is_empty() {
        out.push_str("\nPreconditions:\n");
        for p in &case.preconditions {
            out.push_str(&format!("- {p}\n"));
        }
    }
    out.push_str("\nSteps:\n");
    if case.steps.is_empty() {
        out.push_str("(no structured steps; see body)\n");
    } else {
        for s in &case.steps {
            out.push_str(&format!("{}. {}\n", s.number, s.action));
            if let Some(exp) = &s.expected {
                out.push_str(&format!("   Expected: {exp}\n"));
            }
        }
    }
    out
}

fn context_lines(ctx: &RepoContext) -> String {
    let mut out = String::new();
    if let Some(cfg) = &ctx.config {
        out.push_str(&format!("- Playwright config: {cfg}\n"));
    }
    if let Some(url) = &ctx.base_url {
        out.push_str(&format!("- Base URL: {url} (read from config; do not hardcode)\n"));
    }
    if !ctx.nearby_specs.is_empty() {
        out.push_str(&format!(
            "- Reuse fixtures/page objects from nearby specs: {}\n",
            ctx.nearby_specs.join(", ")
        ));
    }
    out
}

/// Shared confinement footer of the headless generation prompts. The
/// assistant-panel prompt deliberately does not carry it.
const HEADLESS_FOOTER: &str = "Edit only files under the tests directory. Return only file edits.";

/// Prompt to generate a fresh spec from a manual case (docs/05 §5.2).
pub fn generate_prompt(case: &TestCase, ctx: &RepoContext) -> String {
    format!(
        "You are writing a Playwright test for the following manual test case.\n\
Repo conventions:\n{context}\
Create the spec at: {target}\n\n\
Case:\n{rendered}\n\
Requirements:\n\
- Exactly one test() titled exactly \"{title}\".\n\
- Prefer existing page objects/fixtures where they exist.\n\
- Use role/testid selectors; add data-testid suggestions in comments where selectors are missing.\n\
- Do not hardcode secrets or the base URL; read config from the Playwright config.\n\
- Add a comment mapping each block to the manual step number.\n\
{footer}",
        context = context_lines(ctx),
        target = ctx.target_path,
        rendered = render_case(case),
        title = case.front.title,
        footer = HEADLESS_FOOTER,
    )
}

/// Prompt to update a drifted spec, patching rather than rewriting (docs/05 §5.3).
pub fn update_prompt(case: &TestCase, ctx: &RepoContext) -> String {
    let specs = if case.front.automation.specs.is_empty() {
        ctx.target_path.clone()
    } else {
        case.front.automation.specs.join(", ")
    };
    format!(
        "The manual test case below changed; its linked Playwright spec has drifted.\n\
Update the existing spec(s) ({specs}) to match the new steps, patching rather than \
rewriting so custom assertions and helpers are preserved.\n\
Repo conventions:\n{context}\n\
Updated case:\n{rendered}\n\
Requirements:\n\
- Keep the test() title exactly \"{title}\".\n\
- Change only what the updated steps require; preserve unrelated assertions.\n\
- Use role/testid selectors; read config from the Playwright config.\n\
{footer}",
        specs = specs,
        context = context_lines(ctx),
        rendered = render_case(case),
        title = case.front.title,
        footer = HEADLESS_FOOTER,
    )
}

/// The generation/update prompt for the assistant panel, phrased for a CLI
/// coding agent (Claude Code / Codex) with shell access. Unlike the confined
/// headless prompts above it asks the agent to explore the app in a real
/// browser before writing, verify the result in a headed run the user can
/// watch, link the finished spec to the case, and close with a summary.
///
/// `setup` is the team's committed setup notes ([`load_setup`]); when present
/// they ride along so the agent knows how to start the app, which accounts to
/// use, and the local conventions.
pub fn assistant_generation_prompt(
    case: &TestCase,
    ctx: &RepoContext,
    update: bool,
    setup: &str,
) -> String {
    let title = &case.front.title;
    let setup_section = if setup.trim().is_empty() {
        String::new()
    } else {
        format!(
            "Project automation setup notes (maintained by the team; follow them):\n{}\n\n",
            setup.trim()
        )
    };
    let missing_playwright = if ctx.config.is_none() {
        "Note: no Playwright config was detected in this repo. Set Playwright up before the \
workflow below: add @playwright/test as a dev dependency with the repo's package manager, \
create a playwright.config.ts whose `use.baseURL` reads `process.env.BASE_URL`, and run \
`npx playwright install` to download browsers.\n\n"
    } else {
        ""
    };
    let (task, write_step, requirements) = if update {
        let specs = if case.front.automation.specs.is_empty() {
            ctx.target_path.clone()
        } else {
            case.front.automation.specs.join(", ")
        };
        (
            format!(
                "The manual test case below changed; its linked Playwright spec has drifted. \
Update the existing spec(s) ({specs}) to match the new steps, patching rather than \
rewriting so custom assertions and helpers are preserved."
            ),
            "Patch the spec to match the updated steps, changing only what they require."
                .to_string(),
            format!(
                "- Keep the test() title exactly \"{title}\".\n\
- Change only what the updated steps require; preserve unrelated assertions.\n\
- Use role/testid selectors; do not hardcode secrets or the base URL, read them from the Playwright config."
            ),
        )
    } else {
        (
            format!(
                "Write a Playwright test for the manual test case below. \
Create the spec at: {}",
                ctx.target_path
            ),
            "Write the spec, reusing existing page objects and fixtures where they exist."
                .to_string(),
            format!(
                "- Exactly one test() titled exactly \"{title}\".\n\
- Use role/testid selectors; add data-testid suggestions in comments where good selectors are missing.\n\
- Do not hardcode secrets or the base URL; read them from the Playwright config.\n\
- Add a comment mapping each block to the manual step number."
            ),
        )
    };
    format!(
        "{task}\n\n\
{missing_playwright}\
Repo conventions:\n{context}\n\
{setup_section}\
Case:\n{rendered}\n\
Work like this:\n\
1. Explore first: drive a real browser with Playwright in headed mode through the case's \
steps (for example with a short throwaway script) to confirm the flow and discover robust \
selectors. Do not guess selectors from source code alone.\n\
2. {write_step}\n\
3. Verify visually: run the spec in a headed browser so the user can watch it \
(`npx playwright test <path> --headed`; add `--project ...` if the config defines projects). \
If it fails, fix the spec and re-run until it passes.\n\
4. Link the spec to the case: set the case's front-matter `automation` to `state: linked` \
with the spec path(s) in `specs`, and update `automation/links.yml` to match.\n\n\
Requirements:\n{requirements}\n\n\
End your reply with a short summary for the user: what the test covers, the outcome of the \
final headed run (pass or fail, duration), and anything that needs human attention \
(missing test ids, assumptions made, flaky selectors).",
        context = context_lines(ctx),
        rendered = render_case(case),
    )
}

/// Prompt for agent-assisted failure triage (docs/05 §5.6). Read-only: the
/// agent classifies and suggests, it does not edit.
pub fn triage_prompt(case: &TestCase, error: &str, specs: &[String]) -> String {
    format!(
        "A linked Playwright test failed. Classify the failure as one of: \
PRODUCT_BUG, TEST_BUG, or ENVIRONMENT, then explain briefly.\n\n\
Manual case:\n{rendered}\n\
Linked spec(s): {specs}\n\n\
Failure:\n{error}\n\n\
Respond with:\n\
1. Classification (one of the three labels above).\n\
2. A one-paragraph rationale.\n\
3. If TEST_BUG: a concrete fix as a diff. If PRODUCT_BUG: a suggested defect \
summary. If ENVIRONMENT: what to check.\n\
Do not edit any files.",
        rendered = render_case(case),
        specs = if specs.is_empty() { "(none)".into() } else { specs.join(", ") },
        error = error,
    )
}

// ---- links.yml (index of record) ----------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkSpec {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub case: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub specs: Vec<LinkSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    #[serde(default)]
    pub state: AutomationState,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LinksFile {
    #[serde(default)]
    pub links: Vec<Link>,
}

fn links_path(paths: &Paths) -> std::path::PathBuf {
    paths.th.join("automation").join("links.yml")
}

pub fn load_links(paths: &Paths) -> Result<LinksFile> {
    let path = links_path(paths);
    if !path.is_file() {
        return Ok(LinksFile::default());
    }
    Ok(serde_yaml::from_str(&std::fs::read_to_string(&path)?).unwrap_or_default())
}

pub fn save_links(paths: &Paths, links: &LinksFile) -> Result<()> {
    let path = links_path(paths);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_yaml::to_string(links)?)?;
    Ok(())
}

/// Insert or replace the entry for `link.case`, keeping the file sorted by case.
pub fn upsert_link(paths: &Paths, link: Link) -> Result<()> {
    let mut file = load_links(paths)?;
    file.links.retain(|l| l.case != link.case);
    file.links.push(link);
    file.links.sort_by(|a, b| a.case.cmp(&b.case));
    save_links(paths, &file)
}

/// Drop any link entry for `case`. No-op (and no rewrite) if there is none.
pub fn remove_link(paths: &Paths, case: &str) -> Result<()> {
    let mut file = load_links(paths)?;
    let before = file.links.len();
    file.links.retain(|l| l.case != case);
    if file.links.len() != before {
        save_links(paths, &file)?;
    }
    Ok(())
}

// ---- accept flow --------------------------------------------------------------

/// Link generated spec(s) to a case: update the case front matter
/// (`state: linked`, `source_hash`, `specs`, `generator`, `last_synced`) and
/// mirror the entry into `automation/links.yml` (docs/05 §5.2 step 4).
pub fn accept_generation(
    paths: &Paths,
    case_id: &str,
    specs: Vec<String>,
    generator: &str,
) -> Result<TestCase> {
    let mut case = repo::load_case(paths, case_id)?;
    let hash = case_file::content_hash(&case.body);
    let now = now_iso();

    case.front.automation = Automation {
        state: AutomationState::Linked,
        specs: specs.clone(),
        last_synced: Some(now.clone()),
        source_hash: Some(hash.clone()),
        generator: Some(generator.to_string()),
    };
    case.front.updated = Some(now.clone());
    let saved = repo::save_case(paths, &case)?;

    let link_specs = specs
        .iter()
        .map(|s| {
            let r = parse_spec_ref(s);
            LinkSpec {
                path: r.file,
                test: r.test,
            }
        })
        .collect();
    upsert_link(
        paths,
        Link {
            case: case_id.to_string(),
            specs: link_specs,
            generator: Some(generator.to_string()),
            generated_at: Some(now),
            source_hash: Some(hash),
            state: AutomationState::Linked,
        },
    )?;
    Ok(saved)
}

// ---- spec-file discovery & change detection -----------------------------------

/// List spec files (`*.spec.ts|js|mjs`, `*.test.ts`) directly under `dir`,
/// returned repo-relative to `root`. Non-recursive; used for "nearby specs".
fn spec_files_under(dir: &Path, root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        if is_spec_file(&p) {
            out.push(rel(root, &p));
        }
    }
    out.sort();
    out
}

fn is_spec_file(p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.ends_with(".spec.ts")
        || name.ends_with(".spec.js")
        || name.ends_with(".spec.mjs")
        || name.ends_with(".test.ts")
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Recursively find every spec file in the repo (skipping `node_modules`,
/// `.git`, and the TestHound data dir), returned repo-relative and sorted.
pub fn all_spec_files(paths: &Paths) -> Vec<String> {
    let mut out = BTreeSet::new();
    for entry in WalkDir::new(&paths.root)
        .into_iter()
        .filter_entry(|e| !is_ignored_dir(e.path(), paths))
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if p.is_file() && is_spec_file(p) {
            out.insert(rel(&paths.root, p));
        }
    }
    out.into_iter().collect()
}

fn is_ignored_dir(p: &Path, paths: &Paths) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    matches!(name, "node_modules" | ".git") || p == paths.th
}

/// A content-hash snapshot of every spec file, keyed by repo-relative path. Used
/// to detect which specs an agent created or modified across a generation run.
pub fn snapshot_specs(paths: &Paths) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for rel_path in all_spec_files(paths) {
        if let Ok(content) = std::fs::read_to_string(paths.root.join(&rel_path)) {
            map.insert(rel_path, case_file::content_hash(&content));
        }
    }
    map
}

/// Spec files that are new or whose content changed since `before`.
pub fn changed_since(paths: &Paths, before: &BTreeMap<String, String>) -> Vec<String> {
    let after = snapshot_specs(paths);
    let mut changed: Vec<String> = after
        .iter()
        .filter(|(path, hash)| before.get(*path) != Some(*hash))
        .map(|(path, _)| path.clone())
        .collect();
    changed.sort();
    changed
}

// ---- coverage view (docs/05 §5.7) ---------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageRow {
    pub case: String,
    pub title: String,
    pub suite: String,
    pub priority: Priority,
    pub status: CaseStatus,
    pub state: AutomationState,
    pub specs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteCoverage {
    pub id: String,
    pub name: String,
    pub active: usize,
    pub automated: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub rows: Vec<CoverageRow>,
    /// Spec files referenced by no active case (candidates to delete/relink).
    pub orphans: Vec<String>,
    pub total_active: usize,
    pub automated: usize,
    pub drifted: usize,
    pub p1_unautomated: usize,
    pub coverage_pct: u32,
    pub per_suite: Vec<SuiteCoverage>,
}

fn is_automated(state: AutomationState) -> bool {
    matches!(state, AutomationState::Linked | AutomationState::Drifted)
}

/// Build the coverage view: every case with its automation state and specs,
/// orphan specs, and roll-up metrics (overall + per suite).
pub fn coverage(paths: &Paths) -> Result<Coverage> {
    let summaries = repo::list_cases(paths)?;
    let suites = repo::list_suites(paths)?;

    let mut rows = Vec::with_capacity(summaries.len());
    let mut referenced: BTreeSet<String> = BTreeSet::new();

    for s in &summaries {
        let specs = if is_automated(s.automation_state)
            || s.automation_state == AutomationState::Failed
        {
            repo::load_case(paths, &s.id)
                .map(|c| c.front.automation.specs)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        for spec in &specs {
            referenced.insert(parse_spec_ref(spec).file);
        }
        rows.push(CoverageRow {
            case: s.id.clone(),
            title: s.title.clone(),
            suite: s.suite.clone(),
            priority: s.priority,
            status: s.status,
            state: s.automation_state,
            specs,
        });
    }

    // Orphans: spec files on disk that no case points at.
    let orphans: Vec<String> = all_spec_files(paths)
        .into_iter()
        .filter(|f| !referenced.iter().any(|r| spec_eq(r, f)))
        .collect();

    // Metrics over *active* cases only (deprecated/draft don't count against us).
    let active: Vec<&CoverageRow> = rows.iter().filter(|r| r.status == CaseStatus::Active).collect();
    let total_active = active.len();
    let automated = active.iter().filter(|r| is_automated(r.state)).count();
    let drifted = rows.iter().filter(|r| r.state == AutomationState::Drifted).count();
    let p1_unautomated = active
        .iter()
        .filter(|r| {
            matches!(r.priority, Priority::High | Priority::Critical)
                && r.state == AutomationState::None
        })
        .count();
    let coverage_pct = if total_active > 0 {
        ((automated as f64 / total_active as f64) * 100.0).round() as u32
    } else {
        0
    };

    let per_suite = suites
        .iter()
        .map(|s| {
            let suite_rows: Vec<&CoverageRow> = active.iter().copied().filter(|r| r.suite == s.id).collect();
            SuiteCoverage {
                id: s.id.clone(),
                name: s.name.clone(),
                active: suite_rows.len(),
                automated: suite_rows.iter().filter(|r| is_automated(r.state)).count(),
            }
        })
        .collect();

    Ok(Coverage {
        rows,
        orphans,
        total_active,
        automated,
        drifted,
        p1_unautomated,
        coverage_pct,
        per_suite,
    })
}

/// Compare two spec paths tolerating a leading `./` and directory prefix, so a
/// case ref `tests/a.spec.ts` matches a scanned `tests/a.spec.ts`.
fn spec_eq(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_start_matches("./").to_string();
    let (a, b) = (norm(a), norm(b));
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{parse_body, CaseType, FrontMatter};

    fn sample_case() -> TestCase {
        let body = "## Preconditions\n- Logged in\n\n## Steps\n1. Open cart\n   - **Expected:** Cart shows\n";
        let parsed = parse_body(body);
        TestCase {
            front: FrontMatter {
                id: "TC-0007".into(),
                title: "Add item to cart".into(),
                suite: "checkout".into(),
                section: None,
                priority: Priority::High,
                kind: CaseType::Functional,
                status: CaseStatus::Active,
                owner: None,
                tags: vec![],
                references: vec![],
                estimate: None,
                automation: Automation::default(),
                custom: Default::default(),
                created: None,
                updated: None,
            },
            body: body.into(),
            steps: parsed.steps,
            preconditions: parsed.preconditions,
        }
    }

    #[test]
    fn spec_path_convention() {
        assert_eq!(
            spec_path_for(&sample_case(), "tests"),
            "tests/checkout/add-item-to-cart.spec.ts"
        );
        // Honors a project's configured testDir.
        assert_eq!(
            spec_path_for(&sample_case(), "playwright"),
            "playwright/checkout/add-item-to-cart.spec.ts"
        );
    }

    #[test]
    fn generate_prompt_includes_title_steps_and_target() {
        let case = sample_case();
        let ctx = RepoContext {
            config: Some("playwright.config.ts".into()),
            tests_dir: "tests".into(),
            base_url: Some("http://localhost:3000".into()),
            nearby_specs: vec!["tests/checkout/cart.spec.ts".into()],
            target_path: spec_path_for(&case, "tests"),
        };
        let p = generate_prompt(&case, &ctx);
        assert!(p.contains("titled exactly \"Add item to cart\""));
        assert!(p.contains("tests/checkout/add-item-to-cart.spec.ts"));
        assert!(p.contains("Open cart"));
        assert!(p.contains("http://localhost:3000"));
        assert!(p.contains("tests/checkout/cart.spec.ts"));
    }

    #[test]
    fn assistant_prompt_explores_verifies_headed_links_and_summarizes() {
        let case = sample_case();
        let ctx = RepoContext {
            config: None,
            tests_dir: "tests".into(),
            base_url: None,
            nearby_specs: vec![],
            target_path: spec_path_for(&case, "tests"),
        };
        for update in [false, true] {
            let p = assistant_generation_prompt(&case, &ctx, update, "");
            // Not confined like the headless runner.
            assert!(!p.contains(HEADLESS_FOOTER));
            // Explore in a real browser before writing.
            assert!(p.contains("headed mode"));
            // Verify with a headed run the user can watch.
            assert!(p.contains("--headed"));
            // Link the spec to the case afterwards.
            assert!(p.contains("automation/links.yml"));
            // Close with a user-facing summary.
            assert!(p.contains("short summary for the user"));
            // Case payload is still carried.
            assert!(p.contains("Add item to cart"));
            assert!(p.contains("Open cart"));
        }
        let generate = assistant_generation_prompt(&case, &ctx, false, "");
        assert!(generate.contains("tests/checkout/add-item-to-cart.spec.ts"));
        assert!(!generate.contains("setup notes"));
        let update = assistant_generation_prompt(&case, &ctx, true, "");
        assert!(update.contains("has drifted"));
        let with_setup =
            assistant_generation_prompt(&case, &ctx, false, "Start the app with `pnpm dev`.");
        assert!(with_setup.contains("setup notes"));
        assert!(with_setup.contains("Start the app with `pnpm dev`."));
        // ctx has no config, so the agent is told to set Playwright up first;
        // with a config present the note disappears.
        assert!(generate.contains("no Playwright config was detected"));
        let configured = RepoContext {
            config: Some("playwright.config.ts".into()),
            ..ctx
        };
        let p = assistant_generation_prompt(&case, &configured, false, "");
        assert!(!p.contains("no Playwright config was detected"));
    }

    #[test]
    fn triage_prompt_carries_error_and_labels() {
        let p = triage_prompt(&sample_case(), "Expect: badge to be 1", &["tests/a.spec.ts".into()]);
        assert!(p.contains("PRODUCT_BUG"));
        assert!(p.contains("Expect: badge to be 1"));
        assert!(p.contains("tests/a.spec.ts"));
    }

    #[test]
    fn base_url_scrape() {
        let dir = std::env::temp_dir().join(format!("th-baseurl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("playwright.config.ts");
        std::fs::write(&cfg, "export default defineConfig({ use: { baseURL: 'https://acme.test' } })").unwrap();
        assert_eq!(detect_base_url(&cfg).as_deref(), Some("https://acme.test"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn spec_equality_is_suffix_tolerant() {
        assert!(spec_eq("tests/a.spec.ts", "./tests/a.spec.ts"));
        assert!(spec_eq("tests/a.spec.ts", "a.spec.ts"));
        assert!(!spec_eq("tests/a.spec.ts", "tests/b.spec.ts"));
    }
}
