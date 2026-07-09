//! Parsing and serialization of a single test case file: YAML front matter
//! delimited by `---`, followed by a Markdown body.

use crate::domain::{parse_body, FrontMatter, TestCase};
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

/// Stable content hash of the body, used for drift detection. Short hex prefix,
/// mirroring the `source_hash: 9f2ab1` style in the data model.
pub fn content_hash(body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body.trim().as_bytes());
    let digest = hasher.finalize();
    hex6(&digest)
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
    fn hash_is_stable_and_short() {
        assert_eq!(content_hash("abc"), content_hash("  abc\n"));
        assert_eq!(content_hash("abc").len(), 6);
    }
}
