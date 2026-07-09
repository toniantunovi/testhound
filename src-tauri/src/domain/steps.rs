//! Structural parsing of a test case's Markdown body.
//!
//! The body remains plain, readable Markdown, but we parse it into a
//! step/expected table so the UI can render structured steps and map them to
//! Playwright actions (docs/03-data-model.md §3.2).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// 1-based step number as authored.
    pub number: u32,
    /// The action text.
    pub action: String,
    /// Optional expected result (the `- **Expected:** ...` sub-item).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedBody {
    pub preconditions: Vec<String>,
    pub steps: Vec<Step>,
}

#[derive(PartialEq)]
enum Sec {
    None,
    Preconditions,
    Steps,
    Other,
}

/// Parse preconditions and numbered steps out of the body. Unknown sections are
/// ignored for structure but preserved in the raw body that we round-trip.
pub fn parse_body(body: &str) -> ParsedBody {
    let mut out = ParsedBody::default();
    let mut sec = Sec::None;

    for raw in body.lines() {
        let line = raw.trim();

        if let Some(h) = line.strip_prefix("## ") {
            let h = h.trim().to_lowercase();
            sec = match h.as_str() {
                "preconditions" => Sec::Preconditions,
                "steps" => Sec::Steps,
                _ => Sec::Other,
            };
            continue;
        }

        match sec {
            Sec::Preconditions => {
                if let Some(item) = line.strip_prefix("- ") {
                    if !item.is_empty() {
                        out.preconditions.push(item.trim().to_string());
                    }
                }
            }
            Sec::Steps => {
                // An expected sub-item attaches to the last step.
                if let Some(exp) = parse_expected(line) {
                    if let Some(last) = out.steps.last_mut() {
                        last.expected = Some(exp);
                    }
                    continue;
                }
                if let Some((num, action)) = parse_numbered(line) {
                    out.steps.push(Step {
                        number: num,
                        action,
                        expected: None,
                    });
                }
            }
            _ => {}
        }
    }

    out
}

/// Match `- **Expected:** ...` (case-insensitive on the label).
fn parse_expected(line: &str) -> Option<String> {
    let item = line.strip_prefix("- ")?;
    let item = item.trim_start_matches("**").trim_start();
    let lower = item.to_lowercase();
    let rest = lower
        .strip_prefix("expected:")
        .or_else(|| lower.strip_prefix("expected"))?;
    // Recover original-case text after the label position.
    let idx = item.len() - rest.len();
    let text = item[idx..].trim_start_matches(['*', ':', ' ']).trim();
    Some(text.to_string())
}

/// Match `N. action text`.
fn parse_numbered(line: &str) -> Option<(u32, String)> {
    let dot = line.find('.')?;
    let (num_part, rest) = line.split_at(dot);
    let num: u32 = num_part.trim().parse().ok()?;
    let action = rest[1..].trim().to_string();
    if action.is_empty() {
        return None;
    }
    Some((num, action))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_preconditions_and_steps() {
        let body = "\
## Preconditions
- User is logged in
- Product in stock

## Steps
1. Open the product page
   - **Expected:** Details visible
2. Click Add to cart
   - **Expected:** Badge increments

## Notes
edge case here
";
        let p = parse_body(body);
        assert_eq!(p.preconditions.len(), 2);
        assert_eq!(p.steps.len(), 2);
        assert_eq!(p.steps[0].number, 1);
        assert_eq!(p.steps[0].action, "Open the product page");
        assert_eq!(p.steps[0].expected.as_deref(), Some("Details visible"));
        assert_eq!(p.steps[1].expected.as_deref(), Some("Badge increments"));
    }
}
