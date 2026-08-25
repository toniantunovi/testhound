//! Parsing and serialization of a single test case file: YAML front matter
//! delimited by `---`, followed by a Markdown body.

use crate::domain::{parse_body, AutomationState, FrontMatter, TestCase};
use crate::error::{Error, Result};
use sha2::{Digest, Sha256};

/// Split `---\n<yaml>\n---\n<body>` into (Some(yaml), body). If there is no
/// front matter, returns (None, whole input).
pub fn split_front_matter(input: &str) -> (Option<&str>, &str) {
    let s = input.strip_prefix('\u{feff}').unwrap_or(input);
    let after_open = s
        .strip_prefix("---\n")
        .or_else(|| s.strip_prefix("---\r\n"));
    let Some(rest) = after_open else {
        return (None, input);
    };
    // Find a line that is exactly `---`.
    for pat in ["\n---\r\n", "\n---\n", "\n---"] {
        if let Some(idx) = rest.find(pat) {
            let fm = &rest[..idx];
            let mut body = &rest[idx + pat.len()..];
            body = body.strip_prefix('\n').unwrap_or(body);
            body = body.strip_prefix("\r\n").unwrap_or(body);
            return (Some(fm), body);
        }
    }
    (None, input)
}

/// Parse a case file into a full `TestCase` with derived steps.
pub fn parse(content: &str) -> Result<TestCase> {
    let (fm, body) = split_front_matter(content);
    let fm = fm.ok_or_else(|| Error::InvalidFormat("case file has no front matter".into()))?;
    let front: FrontMatter = serde_yaml::from_str(fm)?;
    let body = body.to_string();
    let parsed = parse_body(&body);
    Ok(TestCase {
        front,
        body,
        steps: parsed.steps,
        preconditions: parsed.preconditions,
    })
}

/// Serialize a case back to the file format. Only the front matter and body are
/// written; steps are derived on read.
pub fn serialize(case: &TestCase) -> Result<String> {
    let yaml = serde_yaml::to_string(&case.front)?;
    let body = case.body.trim_end();
    Ok(format!("---\n{yaml}---\n\n{body}\n"))
}

/// Set the front matter's `<key>:` to `value`, editing that one line in place
/// and leaving the rest of the file byte-for-byte alone. Returns `None` when the
/// file already says that. A key the front matter does not have yet is inserted
/// after the last of `after` that it does have, so the documented key order
/// survives. A trailing comment on the key's own line is the one thing that does
/// not survive, since that whole line is rewritten.
///
/// A reorder rewrites every case in a group and a bulk field change every case
/// that was ticked, so neither may go through parse/serialize: that would
/// reformat the YAML of files whose value already matched and drop any front
/// matter key this app does not model, turning one action into a noisy
/// multi-file diff. Only a top-level key counts, never the same name nested
/// inside `automation:` or `custom:`.
///
/// `value` is written verbatim, so it has to be a scalar that needs no quoting:
/// the callers pass numbers and lowercase enum words.
///
/// Editing by line only holds while the lines it touches are single-line scalars.
/// Front matter where they are not (a block scalar, a value on the following
/// line, a second key of the same name) is refused rather than silently
/// corrupted: the caller surfaces the error and the file is left alone.
pub fn set_scalar(content: &str, key: &str, value: &str, after: &[&str]) -> Result<Option<String>> {
    fn bare(line: &str) -> &str {
        line.trim_start_matches('\u{feff}')
            .trim_end_matches(['\n', '\r'])
    }

    // The top-level key a front-matter line declares, or "" for anything indented
    // (nested under `automation:`/`custom:`) or not a key at all. Normalized, so
    // `order : 5` and `"order": 5` are recognized as the same key they are to a
    // YAML parser; missing one would insert a second `order:` and leave the file
    // unparseable.
    fn key_of(line: &str) -> &str {
        let text = bare(line);
        if text.starts_with(char::is_whitespace) {
            return "";
        }
        let Some((raw, _)) = text.split_once(':') else {
            return "";
        };
        let raw = raw.trim();
        raw.strip_prefix('"')
            .and_then(|r| r.strip_suffix('"'))
            .or_else(|| raw.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')))
            .unwrap_or(raw)
    }

    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    if lines.first().copied().map(bare) != Some("---") {
        return Err(Error::InvalidFormat("case file has no front matter".into()));
    }
    let close = (1..lines.len())
        .find(|&i| bare(lines[i]) == "---")
        .ok_or_else(|| Error::InvalidFormat("case file front matter is not closed".into()))?;

    // Does this line hold its whole value, so replacing it (or inserting after it)
    // cannot orphan a continuation?
    let single_line_value = |i: usize| {
        let text = bare(lines[i]);
        let Some((_, value)) = text.split_once(':') else {
            return false;
        };
        let value = value.trim();
        if value.is_empty() || value.starts_with('|') || value.starts_with('>') {
            return false;
        }
        match lines.get(i + 1) {
            // An indented next line continues this value.
            Some(next) => {
                let next = bare(next);
                next.is_empty() || !next.starts_with(char::is_whitespace)
            }
            None => true,
        }
    };

    let target = format!("{key}: {value}");
    let present: Vec<usize> = (1..close).filter(|&i| key_of(lines[i]) == key).collect();
    if present.len() > 1 {
        return Err(Error::InvalidFormat(format!(
            "case file front matter has more than one {key} key"
        )));
    }
    let existing = present.first().copied();
    if let Some(i) = existing {
        if !single_line_value(i) {
            return Err(Error::InvalidFormat(format!(
                "case file's {key} value spans more than one line"
            )));
        }
        if bare(lines[i]).trim_end() == target {
            return Ok(None);
        }
    }

    // Keep the documented key order: after the last key of `after` the file has,
    // which the callers list from the closest preceding key outwards. With none
    // of them (malformed front matter), go directly after the opening fence,
    // which is always structurally safe, rather than appending at the end where
    // the last line may be a block scalar's content.
    let insert_after = match (1..close)
        .filter(|&i| after.contains(&key_of(lines[i])))
        .max()
    {
        Some(i) if single_line_value(i) => i,
        Some(i) => {
            return Err(Error::InvalidFormat(format!(
                "case file's {} value spans more than one line",
                key_of(lines[i])
            )))
        }
        None => 0,
    };
    // Match the line being replaced or followed, not the file: a front matter in
    // LF must not gain a CRLF line because the body happens to have one.
    let newline = if lines[existing.unwrap_or(insert_after)].ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };

    let mut out = String::with_capacity(content.len() + target.len() + 2);
    for (i, line) in lines.iter().enumerate() {
        if existing == Some(i) {
            out.push_str(&target);
            out.push_str(newline);
            continue;
        }
        out.push_str(line);
        if existing.is_none() && i == insert_after {
            out.push_str(&target);
            out.push_str(newline);
        }
    }
    Ok(Some(out))
}

/// Set the front matter's `order:`, the field a drag-reorder writes. See
/// [`set_scalar`] for what an in-place edit does and does not touch.
pub fn set_order(content: &str, order: i64) -> Result<Option<String>> {
    set_scalar(content, "order", &order.to_string(), &["section", "suite"])
}

/// Stable content hash of the body, used for drift detection. Short hex prefix,
/// mirroring the `source_hash: 9f2ab1` style in the data model.
pub fn content_hash(body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body.trim().as_bytes());
    let digest = hasher.finalize();
    hex6(&digest)
}

/// Recompute a case's automation link state from its body (docs/05 §5.3). A
/// `linked` or `drifted` case whose body no longer matches the recorded
/// `source_hash` becomes `drifted`; one whose body matches again returns to
/// `linked`. Cases with no link, or mid-generation, are left untouched. Called
/// on every save so editing a linked case surfaces drift immediately.
pub fn apply_drift(front: &mut FrontMatter, body: &str) {
    if !matches!(
        front.automation.state,
        AutomationState::Linked | AutomationState::Drifted
    ) {
        return;
    }
    let Some(recorded) = front.automation.source_hash.as_deref() else {
        return;
    };
    front.automation.state = if content_hash(body) == recorded {
        AutomationState::Linked
    } else {
        AutomationState::Drifted
    };
}

fn hex6(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(3)
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_front_matter_and_body() {
        let content = "\
---
id: TC-0007
title: Add item to cart
suite: checkout
priority: high
type: functional
status: active
tags:
- cart
- p1
---

## Steps
1. Open the product page
   - **Expected:** Details visible
";
        let case = parse(content).unwrap();
        assert_eq!(case.front.id, "TC-0007");
        assert_eq!(case.front.tags, vec!["cart", "p1"]);
        assert_eq!(case.steps.len(), 1);

        let out = serialize(&case).unwrap();
        let reparsed = parse(&out).unwrap();
        assert_eq!(reparsed.front.title, "Add item to cart");
        assert_eq!(reparsed.steps[0].expected.as_deref(), Some("Details visible"));
    }

    #[test]
    fn set_order_edits_one_line_and_keeps_everything_else() {
        // Note `component:`, a key this app does not model, and a comment: a
        // reorder must not be able to destroy either.
        let content = "\
---
id: TC-0007
title: Add item to cart
suite: checkout
section: cart
priority: high
component: cart # hand-added
tags:
- cart
automation:
  state: linked
  order: not-a-key # nested, must be ignored
---

## Steps
1. Open the product page
";
        let out = set_order(content, 20).unwrap().unwrap();
        assert!(out.contains("section: cart\norder: 20\npriority: high"));
        assert!(out.contains("component: cart # hand-added"));
        assert!(out.contains("  order: not-a-key # nested, must be ignored"));
        assert_eq!(out.lines().count(), content.lines().count() + 1);
        assert_eq!(parse(&out).unwrap().front.order, Some(20));

        // Rewriting the same value is a no-op, so a drag that lands where it
        // started leaves the file (and the Git diff) untouched.
        assert!(set_order(&out, 20).unwrap().is_none());

        // An existing order is replaced in place, not duplicated.
        let changed = set_order(&out, 30).unwrap().unwrap();
        assert_eq!(changed.matches("\norder:").count(), 1);
        assert_eq!(parse(&changed).unwrap().front.order, Some(30));
        assert_eq!(changed.lines().count(), out.lines().count());
    }

    #[test]
    fn set_order_handles_sparse_front_matter_and_crlf() {
        // No `section:`: the order line follows `suite:`.
        let minimal = "---\nid: TC-1\ntitle: T\nsuite: s\n---\n\n## Steps\n1. Go\n";
        let out = set_order(minimal, 10).unwrap().unwrap();
        assert!(out.contains("suite: s\norder: 10\n"));
        assert_eq!(parse(&out).unwrap().front.order, Some(10));

        // CRLF files keep their line endings.
        let crlf = "---\r\nid: TC-2\r\ntitle: T\r\nsuite: s\r\n---\r\n\r\n## Steps\r\n1. Go\r\n";
        let out = set_order(crlf, 10).unwrap().unwrap();
        assert!(out.contains("suite: s\r\norder: 10\r\n"));
        assert_eq!(parse(&out).unwrap().front.order, Some(10));

        // A file with no front matter is an error, never a silent rewrite.
        assert!(set_order("## Steps\n1. Go\n", 10).is_err());
        assert!(set_order("---\nid: TC-3\n", 10).is_err());
    }

    #[test]
    fn set_order_recognizes_every_spelling_of_the_key() {
        // A YAML parser reads all three as the key `order`. Missing one would add
        // a second `order:` and leave the case permanently unparseable.
        for spelling in ["order : 5", "\"order\": 5", "'order': 5", "order:5"] {
            let content =
                format!("---\nid: TC-1\ntitle: T\nsuite: s\n{spelling}\n---\n\n## Steps\n1. Go\n");
            let out = set_order(&content, 10).unwrap().unwrap();
            assert_eq!(
                out.matches("order").count(),
                1,
                "{spelling} should be replaced, not duplicated"
            );
            assert_eq!(parse(&out).unwrap().front.order, Some(10), "{spelling}");
            assert!(set_order(&out, 10).unwrap().is_none(), "{spelling}");
        }
    }

    #[test]
    fn set_order_refuses_front_matter_it_cannot_edit_by_line() {
        // A value that continues onto the next line cannot be replaced or
        // inserted after by line index, so the file is left alone.
        let cases = [
            // Block scalar as the insertion anchor.
            "---\nid: TC-1\ntitle: T\nsuite: >-\n  s\n---\n\nbody\n",
            // `order:` with its value on the following line.
            "---\nid: TC-1\ntitle: T\nsuite: s\norder:\n  5\n---\n\nbody\n",
            // Two order keys: which one wins is not ours to guess.
            "---\nid: TC-1\ntitle: T\nsuite: s\norder: 5\norder : 7\n---\n\nbody\n",
        ];
        for content in cases {
            assert!(
                set_order(content, 10).is_err(),
                "should refuse rather than corrupt: {content:?}"
            );
        }
    }

    #[test]
    fn set_order_takes_its_line_ending_from_the_line_it_touches() {
        // LF front matter, one CRLF line in the body: the inserted line stays LF.
        let mixed = "---\nid: TC-1\ntitle: T\nsuite: s\n---\n\nline one\r\nline two\n";
        let out = set_order(mixed, 10).unwrap().unwrap();
        assert!(out.contains("suite: s\norder: 10\n"));
        assert!(!out.contains("order: 10\r\n"));
        assert!(out.contains("line one\r\n"), "the body is untouched");

        // A BOM survives, and front matter with neither suite nor section gets the
        // key right after the fence rather than after a possibly-continuing line.
        let bom = "\u{feff}---\nid: TC-1\ntitle: T\n---\n\nbody\n";
        let out = set_order(bom, 10).unwrap().unwrap();
        assert!(out.starts_with("\u{feff}---\norder: 10\n"));
        assert!(set_order(&out, 10).unwrap().is_none());
    }

    #[test]
    fn set_scalar_replaces_a_key_or_inserts_it_in_the_documented_order() {
        const AFTER_STATUS: &[&str] = &["type", "priority", "order", "section", "suite"];

        // The key is there: its line is replaced and nothing around it moves.
        let content = "\
---
id: TC-0007
title: Add item to cart
suite: checkout
priority: high
type: smoke
status: active
component: cart # hand-added
---

## Steps
1. Open the product page
";
        let out = set_scalar(content, "status", "deprecated", AFTER_STATUS)
            .unwrap()
            .unwrap();
        assert!(out.contains("type: smoke\nstatus: deprecated\ncomponent:"));
        assert!(out.contains("component: cart # hand-added"));
        assert_eq!(out.lines().count(), content.lines().count());
        assert_eq!(
            parse(&out).unwrap().front.status,
            crate::domain::CaseStatus::Deprecated
        );
        // Setting the value it already holds leaves the file (and the diff) alone.
        assert!(set_scalar(&out, "status", "deprecated", AFTER_STATUS)
            .unwrap()
            .is_none());

        // A file that never carried the key gains it after the last key it may
        // follow, not at the end of the front matter.
        let sparse = "---\nid: TC-1\ntitle: T\nsuite: s\npriority: high\ntags:\n- a\n---\n\nbody\n";
        let out = set_scalar(sparse, "status", "draft", AFTER_STATUS)
            .unwrap()
            .unwrap();
        assert!(out.contains("priority: high\nstatus: draft\ntags:"));
        assert_eq!(
            parse(&out).unwrap().front.status,
            crate::domain::CaseStatus::Draft
        );
    }

    #[test]
    fn hash_is_stable_and_short() {
        assert_eq!(content_hash("abc"), content_hash("  abc\n"));
        assert_eq!(content_hash("abc").len(), 6);
    }
}
