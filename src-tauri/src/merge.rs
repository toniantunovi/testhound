//! Semantic 3-way merge for TestHound case files (docs/04-git-storage.md §4.6).
//!
//! When an ordinary `git merge`/`git pull` leaves a case file conflicted, Git
//! writes three versions into the index: the common ancestor (stage 1), *ours*
//! (stage 2) and *theirs* (stage 3). Instead of surfacing raw `<<<<<<<`
//! conflict markers, TestHound parses all three into structured cases and
//! presents a **field- and step-level** merge: for every field that differs it
//! shows the base/ours/theirs value, whether the two sides genuinely conflict,
//! and a suggested side. The user picks a side per field and TestHound writes a
//! clean, well-formed case file, then stages it to resolve the conflict.
//!
//! It also detects `next_case_id` collisions (two branches minting the same
//! `TC-####`) and offers an automatic renumber-with-relink fix.

use crate::domain::{FrontMatter, Step, TestCase};
use crate::error::{Error, Result};
use crate::repo::{self, case_file, Paths};
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Which version of a conflicted field a resolution takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Base,
    Ours,
    Theirs,
}

/// One mergeable field of a case: a front-matter scalar/list, the preconditions
/// block, a single step, or the free-form "notes" (any non-standard body
/// section). Only fields that actually differ across the three versions are
/// emitted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMerge {
    /// Stable key used when POSTing a resolution (e.g. `title`, `priority`,
    /// `step-2`, `preconditions`, `notes`).
    pub key: String,
    /// Human label for the field.
    pub label: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    /// True when both sides changed the field to different values (a genuine
    /// conflict). False when only one side changed it (auto-resolvable).
    pub conflict: bool,
    /// The side TestHound suggests: the changed side for a one-sided edit, or
    /// `Ours` as a safe default for a genuine conflict.
    pub suggested: Side,
}

/// The semantic 3-way merge of a single conflicted case file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseMerge {
    pub path: String,
    pub id: String,
    pub title: String,
    pub fields: Vec<FieldMerge>,
    /// Any field is a genuine two-sided conflict.
    pub has_conflict: bool,
    /// Set when one side deleted the file and the other modified it. The UI then
    /// offers keep-ours vs. accept-deletion rather than a field merge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_side: Option<Side>,
}

/// A conflicted path that isn't a case file (spec, config, etc.). Surfaced so
/// the UI can list it and point the user at their normal Git tooling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawConflict {
    pub path: String,
}

/// All conflicts in the index, split into the ones TestHound can merge
/// semantically (case files) and the rest.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Conflicts {
    pub cases: Vec<CaseMerge>,
    pub other: Vec<RawConflict>,
    /// True while a merge is in progress (MERGE_HEAD exists), including after
    /// every conflict is resolved but before the concluding commit.
    pub merging: bool,
}

/// The three blob contents of a conflicted path (any may be missing).
struct Sides {
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
}

fn blob_text(repo: &Repository, entry: &git2::IndexEntry) -> Option<String> {
    let blob = repo.find_blob(entry.id).ok()?;
    Some(String::from_utf8_lossy(blob.content()).into_owned())
}

/// Read the three conflict stages for every conflicted path in the index.
fn conflict_sides(repo: &Repository) -> Result<Vec<(String, Sides)>> {
    let index = repo.index()?;
    let mut out = Vec::new();
    for c in index.conflicts()? {
        let c = c?;
        let entry = c
            .our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref());
        let Some(entry) = entry else { continue };
        let path = String::from_utf8_lossy(&entry.path).replace('\\', "/");
        out.push((
            path,
            Sides {
                base: c.ancestor.as_ref().and_then(|e| blob_text(repo, e)),
                ours: c.our.as_ref().and_then(|e| blob_text(repo, e)),
                theirs: c.their.as_ref().and_then(|e| blob_text(repo, e)),
            },
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// A conflicted path is a case file when it lives under a suite's `cases/`
/// directory and ends in `.md`.
fn is_case_path(path: &str) -> bool {
    path.ends_with(".md") && path.contains("/cases/") && path.contains("/suites/")
}

/// Enumerate all index conflicts, building a semantic merge for each case file.
pub fn conflicts(repo: &Repository) -> Result<Conflicts> {
    let mut out = Conflicts {
        merging: repo.state() == git2::RepositoryState::Merge,
        ..Conflicts::default()
    };
    for (path, sides) in conflict_sides(repo)? {
        if is_case_path(&path) {
            out.cases.push(build_case_merge(&path, &sides));
        } else {
            out.other.push(RawConflict { path });
        }
    }
    Ok(out)
}

fn parse_side(text: &Option<String>) -> Option<TestCase> {
    text.as_deref().and_then(|t| case_file::parse(t).ok())
}

fn build_case_merge(path: &str, sides: &Sides) -> CaseMerge {
    let base = parse_side(&sides.base);
    let ours = parse_side(&sides.ours);
    let theirs = parse_side(&sides.theirs);

    // Modify/delete: one side removed the file entirely.
    let deleted_side = match (sides.ours.is_some(), sides.theirs.is_some()) {
        (false, true) => Some(Side::Ours),
        (true, false) => Some(Side::Theirs),
        _ => None,
    };

    let primary = ours.as_ref().or(theirs.as_ref()).or(base.as_ref());
    let id = primary.map(|c| c.front.id.clone()).unwrap_or_default();
    let title = primary.map(|c| c.front.title.clone()).unwrap_or_default();

    let mut fields = Vec::new();
    if deleted_side.is_none() {
        for (key, label) in SCALAR_FIELDS {
            let get = |c: &Option<TestCase>| c.as_ref().and_then(|c| scalar_value(&c.front, key));
            push_field(&mut fields, key, label, get(&base), get(&ours), get(&theirs));
        }
        // Preconditions block.
        let pre = |c: &Option<TestCase>| {
            c.as_ref()
                .filter(|c| !c.preconditions.is_empty())
                .map(|c| c.preconditions.join("\n"))
        };
        push_field(
            &mut fields,
            "preconditions",
            "Preconditions",
            pre(&base),
            pre(&ours),
            pre(&theirs),
        );
        // One field per step, aligned by position.
        let max_steps = [&base, &ours, &theirs]
            .iter()
            .filter_map(|c| c.as_ref().map(|c| c.steps.len()))
            .max()
            .unwrap_or(0);
        for n in 0..max_steps {
            let step = |c: &Option<TestCase>| c.as_ref().and_then(|c| step_value(c.steps.get(n)));
            let key = format!("step-{}", n + 1);
            push_field_owned(
                &mut fields,
                key,
                format!("Step {}", n + 1),
                step(&base),
                step(&ours),
                step(&theirs),
            );
        }
        // Free-form remainder of the body (any non-standard sections).
        let notes = |c: &Option<TestCase>| {
            c.as_ref()
                .map(|c| body_extra(&c.body))
                .filter(|s| !s.is_empty())
        };
        push_field(
            &mut fields,
            "notes",
            "Notes",
            notes(&base),
            notes(&ours),
            notes(&theirs),
        );
    }

    let has_conflict = deleted_side.is_some() || fields.iter().any(|f| f.conflict);
    CaseMerge {
        path: path.to_string(),
        id,
        title,
        fields,
        has_conflict,
        deleted_side,
    }
}

/// Front-matter fields eligible for field-level merge, in display order.
const SCALAR_FIELDS: &[(&str, &str)] = &[
    ("title", "Title"),
    ("suite", "Suite"),
    ("section", "Section"),
    ("priority", "Priority"),
    ("type", "Type"),
    ("status", "Status"),
    ("owner", "Owner"),
    ("estimate", "Estimate"),
    ("tags", "Tags"),
    ("references", "References"),
];

fn scalar_value(f: &FrontMatter, key: &str) -> Option<String> {
    let lower = |v: &dyn std::fmt::Debug| format!("{v:?}").to_lowercase();
    match key {
        "title" => Some(f.title.clone()),
        "suite" => Some(f.suite.clone()),
        "section" => f.section.clone(),
        "priority" => Some(lower(&f.priority)),
        "type" => Some(lower(&f.kind)),
        "status" => Some(lower(&f.status)),
        "owner" => f.owner.clone(),
        "estimate" => f.estimate.clone(),
        "tags" => (!f.tags.is_empty()).then(|| f.tags.join(", ")),
        "references" => (!f.references.is_empty()).then(|| f.references.join(", ")),
        _ => None,
    }
}

fn step_value(step: Option<&Step>) -> Option<String> {
    step.map(|s| match &s.expected {
        Some(e) => format!("{}\n↳ Expected: {e}", s.action),
        None => s.action.clone(),
    })
}

/// Copy a merged field's value from `src` into `target`. Scalars/lists only;
/// the body-derived fields (preconditions/steps/notes) are handled separately.
fn apply_scalar(target: &mut FrontMatter, key: &str, src: &FrontMatter) {
    match key {
        "title" => target.title = src.title.clone(),
        "suite" => target.suite = src.suite.clone(),
        "section" => target.section = src.section.clone(),
        "priority" => target.priority = src.priority,
        "type" => target.kind = src.kind,
        "status" => target.status = src.status,
        "owner" => target.owner = src.owner.clone(),
        "estimate" => target.estimate = src.estimate.clone(),
        "tags" => target.tags = src.tags.clone(),
        "references" => target.references = src.references.clone(),
        _ => {}
    }
}

fn push_field(
    fields: &mut Vec<FieldMerge>,
    key: &str,
    label: &str,
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
) {
    push_field_owned(fields, key.to_string(), label.to_string(), base, ours, theirs);
}

fn push_field_owned(
    fields: &mut Vec<FieldMerge>,
    key: String,
    label: String,
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
) {
    // Skip fields that are identical across the present versions.
    if ours == theirs && (base.is_none() || base == ours) {
        return;
    }
    let (conflict, suggested) = classify(&base, &ours, &theirs);
    fields.push(FieldMerge {
        key,
        label,
        base,
        ours,
        theirs,
        conflict,
        suggested,
    });
}

/// Decide whether a field is a genuine conflict and which side to suggest.
fn classify(
    base: &Option<String>,
    ours: &Option<String>,
    theirs: &Option<String>,
) -> (bool, Side) {
    if ours == theirs {
        return (false, Side::Ours);
    }
    match base {
        // No common ancestor (add/add): any difference is a conflict.
        None => (true, Side::Ours),
        Some(_) => {
            if ours == base {
                (false, Side::Theirs) // only theirs changed
            } else if theirs == base {
                (false, Side::Ours) // only ours changed
            } else {
                (true, Side::Ours) // both changed differently
            }
        }
    }
}

/// Rebuild a case body from merged parts: canonical Preconditions and Steps
/// sections followed by any preserved free-form remainder.
fn render_body(preconditions: &[String], steps: &[Step], extra: &str) -> String {
    let mut out = String::new();
    if !preconditions.is_empty() {
        out.push_str("## Preconditions\n");
        for p in preconditions {
            out.push_str(&format!("- {p}\n"));
        }
        out.push('\n');
    }
    if !steps.is_empty() {
        out.push_str("## Steps\n");
        for (i, s) in steps.iter().enumerate() {
            out.push_str(&format!("{}. {}\n", i + 1, s.action));
            if let Some(e) = &s.expected {
                out.push_str(&format!("   - **Expected:** {e}\n"));
            }
        }
        out.push('\n');
    }
    if !extra.is_empty() {
        out.push_str(extra.trim());
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// The body with the canonical `## Preconditions` and `## Steps` sections
/// removed, so a merge can preserve arbitrary extra sections (e.g. `## Notes`).
fn body_extra(body: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for line in body.lines() {
        if let Some(h) = line.trim().strip_prefix("## ") {
            skip = matches!(h.trim().to_lowercase().as_str(), "preconditions" | "steps");
            if skip {
                continue;
            }
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

/// Resolve a conflicted case file by picking a side per field, writing a clean
/// merged file, and staging it. `picks` maps a `FieldMerge.key` to the chosen
/// side; any field not present uses its suggested side.
pub fn resolve_case(
    paths: &Paths,
    path: &str,
    picks: &BTreeMap<String, Side>,
) -> Result<TestCase> {
    let repo = crate::git::open(&paths.root)?;
    let sides = conflict_sides(&repo)?
        .into_iter()
        .find(|(p, _)| p == path)
        .map(|(_, s)| s)
        .ok_or_else(|| Error::InvalidFormat(format!("no conflict at {path}")))?;

    let base = parse_side(&sides.base);
    let ours = parse_side(&sides.ours);
    let theirs = parse_side(&sides.theirs);
    let pick = |side: Side| -> Option<&TestCase> {
        match side {
            Side::Base => base.as_ref(),
            Side::Ours => ours.as_ref(),
            Side::Theirs => theirs.as_ref(),
        }
    };

    let merge = build_case_merge(path, &sides);
    let suggested: BTreeMap<&str, Side> =
        merge.fields.iter().map(|f| (f.key.as_str(), f.suggested)).collect();
    let side_for = |key: &str| picks.get(key).copied().or_else(|| suggested.get(key).copied());

    let primary = ours.clone().or_else(|| theirs.clone()).or_else(|| base.clone());
    let mut front = primary
        .as_ref()
        .map(|c| c.front.clone())
        .ok_or_else(|| Error::InvalidFormat("nothing to merge".into()))?;

    // Front-matter scalars/lists: apply the chosen side for each merged field.
    for (key, _) in SCALAR_FIELDS {
        if let Some(side) = side_for(key) {
            if let Some(src) = pick(side) {
                apply_scalar(&mut front, key, &src.front);
            }
        }
    }

    // Preconditions.
    let pre_side = side_for("preconditions").unwrap_or(Side::Ours);
    let preconditions = pick(pre_side)
        .map(|c| c.preconditions.clone())
        .unwrap_or_default();

    // Steps: for each position take the chosen (or suggested, or ours) side's
    // step if it has one, then renumber sequentially.
    let max_steps = [&base, &ours, &theirs]
        .iter()
        .filter_map(|c| c.as_ref().map(|c| c.steps.len()))
        .max()
        .unwrap_or(0);
    let mut steps = Vec::new();
    for n in 0..max_steps {
        let key = format!("step-{}", n + 1);
        let side = side_for(&key).unwrap_or(Side::Ours);
        if let Some(src) = pick(side) {
            if let Some(step) = src.steps.get(n) {
                steps.push(step.clone());
            }
        }
    }

    // Notes / free-form remainder.
    let notes_side = side_for("notes").unwrap_or(Side::Ours);
    let extra = pick(notes_side)
        .map(|c| body_extra(&c.body))
        .unwrap_or_default();

    let body = render_body(&preconditions, &steps, &extra);
    case_file::apply_drift(&mut front, &body);
    let merged = TestCase {
        front,
        body,
        steps: vec![],
        preconditions: vec![],
    };

    // Write the clean file and stage it, clearing the conflict.
    let saved = repo::save_case(paths, &merged)?;
    stage_path(&repo, path)?;
    Ok(saved)
}

/// Accept the deletion of a conflicted case file (the "theirs deleted, keep
/// deletion" resolution): remove it from the working tree and stage the removal.
pub fn resolve_delete(paths: &Paths, path: &str) -> Result<()> {
    let repo = crate::git::open(&paths.root)?;
    let abs = paths.root.join(path);
    if abs.exists() {
        std::fs::remove_file(&abs)?;
    }
    let mut index = repo.index()?;
    index.remove_path(Path::new(path))?;
    index.write()?;
    Ok(())
}

/// Keep a modified case over the other side's deletion: write ours and stage it.
pub fn resolve_keep(paths: &Paths, path: &str, keep: Side) -> Result<TestCase> {
    let repo = crate::git::open(&paths.root)?;
    let sides = conflict_sides(&repo)?
        .into_iter()
        .find(|(p, _)| p == path)
        .map(|(_, s)| s)
        .ok_or_else(|| Error::InvalidFormat(format!("no conflict at {path}")))?;
    let text = match keep {
        Side::Ours => sides.ours,
        Side::Theirs => sides.theirs,
        Side::Base => sides.base,
    }
    .ok_or_else(|| Error::InvalidFormat("chosen side has no content".into()))?;
    let mut case = case_file::parse(&text)?;
    case_file::apply_drift(&mut case.front, &case.body);
    let saved = repo::save_case(paths, &case)?;
    stage_path(&repo, path)?;
    Ok(saved)
}

fn stage_path(repo: &Repository, path: &str) -> Result<()> {
    let mut index = repo.index()?;
    index.add_path(Path::new(path))?;
    index.write()?;
    Ok(())
}

// ---- next_case_id collisions ---------------------------------------------------

/// Two or more case files claiming the same `TC-####` id (a classic merge
/// artifact when both branches minted a new case).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdCollision {
    pub id: String,
    /// Repo-relative paths of the colliding files.
    pub paths: Vec<String>,
}

/// Scan the working tree for duplicate case ids.
pub fn detect_id_collisions(paths: &Paths) -> Result<Vec<IdCollision>> {
    let mut by_id: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for c in repo::list_cases(paths)? {
        by_id.entry(c.id.clone()).or_default().push(c.path.clone());
    }
    let mut out: Vec<IdCollision> = by_id
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|(id, mut paths)| {
            paths.sort();
            IdCollision { id, paths }
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Renumber the case at `path` to a fresh id, relinking its references in
/// `automation/links.yml` and any run result files (docs/04 §4.6). Returns the
/// new id. Used to resolve a `next_case_id` collision without losing history in
/// the other colliding case.
pub fn renumber_case(paths: &Paths, path: &str) -> Result<String> {
    let abs = paths.root.join(path);
    let content = std::fs::read_to_string(&abs)?;
    let mut case = case_file::parse(&content)?;
    let old_id = case.front.id.clone();
    let new_id = repo::next_case_id(paths)?;
    case.front.id = new_id.clone();

    // Write under a filename derived from the new id, removing the old file.
    let cases_dir = abs.parent().ok_or_else(|| Error::InvalidFormat("bad case path".into()))?;
    let slug = slug::slugify(&case.front.title);
    let new_path = cases_dir.join(format!("{new_id}-{slug}.md"));
    std::fs::write(&new_path, case_file::serialize(&case)?)?;
    if new_path != abs {
        std::fs::remove_file(&abs).ok();
    }

    relink_id(paths, &old_id, &new_id)?;
    Ok(new_id)
}

/// Repoint every id reference from `old_id` to `new_id`: the automation links
/// index and each run's result file (both its `<id>.yml` name and `case:` field).
fn relink_id(paths: &Paths, old_id: &str, new_id: &str) -> Result<()> {
    // automation/links.yml
    let mut links = crate::automation::load_links(paths)?;
    let mut touched = false;
    for l in &mut links.links {
        if l.case == old_id {
            l.case = new_id.to_string();
            touched = true;
        }
    }
    if touched {
        crate::automation::save_links(paths, &links)?;
    }

    // runs/<run>/results/<case>.yml
    let runs_dir = paths.th.join("runs");
    if runs_dir.is_dir() {
        for run in std::fs::read_dir(&runs_dir)?.filter_map(|e| e.ok()) {
            let results = run.path().join("results");
            let old_file = results.join(format!("{old_id}.yml"));
            if old_file.is_file() {
                let text = std::fs::read_to_string(&old_file)?;
                let patched =
                    text.replace(&format!("case: {old_id}"), &format!("case: {new_id}"));
                std::fs::write(results.join(format!("{new_id}.yml")), patched)?;
                std::fs::remove_file(&old_file).ok();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tc(title: &str, priority: &str, steps: &[(&str, &str)]) -> String {
        let mut body = String::from("## Preconditions\n- Logged in\n\n## Steps\n");
        for (i, (a, e)) in steps.iter().enumerate() {
            body.push_str(&format!("{}. {a}\n   - **Expected:** {e}\n", i + 1));
        }
        format!(
            "---\nid: TC-0007\ntitle: {title}\nsuite: checkout\npriority: {priority}\ntype: functional\nstatus: active\n---\n\n{body}"
        )
    }

    fn sides(base: &str, ours: &str, theirs: &str) -> Sides {
        Sides {
            base: Some(base.to_string()),
            ours: Some(ours.to_string()),
            theirs: Some(theirs.to_string()),
        }
    }

    #[test]
    fn one_sided_title_edit_auto_resolves_to_that_side() {
        let base = tc("Add to cart", "high", &[("Open", "Shown")]);
        let ours = base.clone();
        let theirs = tc("Add item to cart", "high", &[("Open", "Shown")]);
        let m = build_case_merge("suites/checkout/cases/TC-0007-x.md", &sides(&base, &ours, &theirs));
        assert!(!m.has_conflict);
        let title = m.fields.iter().find(|f| f.key == "title").unwrap();
        assert!(!title.conflict);
        assert_eq!(title.suggested, Side::Theirs);
    }

    #[test]
    fn two_sided_priority_edit_is_a_conflict() {
        let base = tc("T", "medium", &[("Open", "Shown")]);
        let ours = tc("T", "high", &[("Open", "Shown")]);
        let theirs = tc("T", "critical", &[("Open", "Shown")]);
        let m = build_case_merge("suites/checkout/cases/TC-0007-x.md", &sides(&base, &ours, &theirs));
        assert!(m.has_conflict);
        let pr = m.fields.iter().find(|f| f.key == "priority").unwrap();
        assert!(pr.conflict);
        assert_eq!(pr.base.as_deref(), Some("medium"));
        assert_eq!(pr.ours.as_deref(), Some("high"));
        assert_eq!(pr.theirs.as_deref(), Some("critical"));
    }

    #[test]
    fn identical_fields_are_not_emitted() {
        let base = tc("T", "high", &[("Open", "Shown")]);
        let m = build_case_merge("suites/checkout/cases/TC-0007-x.md", &sides(&base, &base, &base));
        assert!(m.fields.is_empty());
        assert!(!m.has_conflict);
    }

    #[test]
    fn step_level_difference_is_detected() {
        let base = tc("T", "high", &[("Open page", "Shown")]);
        let ours = tc("T", "high", &[("Open the product page", "Shown")]);
        let theirs = base.clone();
        let m = build_case_merge("suites/checkout/cases/TC-0007-x.md", &sides(&base, &ours, &theirs));
        let step = m.fields.iter().find(|f| f.key == "step-1").unwrap();
        assert_eq!(step.suggested, Side::Ours);
        assert!(!step.conflict);
    }

    #[test]
    fn render_body_round_trips_through_the_parser() {
        let steps = vec![
            Step { number: 1, action: "Open".into(), expected: Some("Shown".into()) },
            Step { number: 2, action: "Click".into(), expected: None },
        ];
        let body = render_body(&["Logged in".to_string()], &steps, "## Notes\nedge case");
        let parsed = crate::domain::parse_body(&body);
        assert_eq!(parsed.preconditions, vec!["Logged in"]);
        assert_eq!(parsed.steps.len(), 2);
        assert_eq!(parsed.steps[0].expected.as_deref(), Some("Shown"));
        assert!(body.contains("## Notes"));
    }

    #[test]
    fn body_extra_strips_known_sections() {
        let body = "## Preconditions\n- A\n\n## Steps\n1. Do\n\n## Notes\nkeep me";
        assert_eq!(body_extra(body), "## Notes\nkeep me");
    }
}
