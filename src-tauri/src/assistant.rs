//! The conversational assistant: context and prompt building for the side
//! panel that runs a coding agent (Claude Code / Codex) against the repo.
//!
//! The actual process spawning, streaming, and session resume live in
//! [`crate::automation::agent`]. This module only produces the strings that
//! shape a turn: the TestHound-aware system preamble and, for agents without
//! native session resume, the rolled-up transcript prompt.

use crate::automation::agent::AgentKind;
use crate::repo::Paths;
use serde::{Deserialize, Serialize};

/// One message in the panel transcript. Owned by the frontend and passed back
/// each turn so agents without native resume (Codex) can be given the history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// `"user"` or `"assistant"`.
    pub role: String,
    pub content: String,
}

/// The standing instructions handed to the agent every turn. Describes the
/// repo-as-database layout, the case file format, how to perform the common
/// tasks, and the safety model (changes are auto-applied; git is the net).
pub fn system_preamble(paths: &Paths) -> String {
    let th = paths
        .th
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("testhound");
    format!(
        r#"You are the TestHound Assistant, embedded in a Git-native, AI-powered test
management desktop app. You act directly on the repository, which IS the
database: every test case, suite, run, result, and configuration is a plain
file under `{th}/` in the current working directory.

You already know the TestHound file format precisely (it is specified in full
below). Do NOT reverse-engineer it or ask the user how cases are stored. You may
Read existing files to see current data and conventions (suite ids, tag usage,
owners), but always write files that conform exactly to the schema below.

REPOSITORY LAYOUT
- `{th}/project.yml` - project metadata, including `next_case_id`.
- `{th}/suites/<suite-id>/suite.yml` - a suite definition.
- `{th}/suites/<suite-id>/cases/<TC-####>-<slug>.md` - a test case.
- `{th}/suites/<suite-id>/sections/<section-id>.yml` - an optional section.
- `{th}/runs/` - test runs and their recorded results.
- `{th}/milestones/`, `{th}/configurations/` - milestones and configurations. A
  configuration option is a reporting dimension (e.g. a browser × form-factor);
  give an option a `playwright_project:` to have runs tagged with it pass
  `--project=<value>` to Playwright, otherwise the run uses the config's default.
- `{th}/automation/links.yml` - links between manual cases and Playwright specs.
- Playwright specs live under the project's `tests/` directory.

TEST CASE FILE FORMAT
A case file is YAML front matter between `---` fences, then a Markdown body.
Front-matter keys, in this order (omit optional keys when empty, never write
`null`):
- id        (required)  e.g. `TC-0042`
- title     (required)  one line
- suite     (required)  the suite id (folder name), e.g. `checkout`
- section   (optional)  a section id within the suite
- priority  (default medium)  one of: low | medium | high | critical
- type      (default functional)  one of: functional | regression | smoke | e2e | negative | a11y | perf
- status    (default active)  one of: draft | active | deprecated
- owner     (optional)  a short username
- tags      (optional)  a YAML list of strings
- references(optional)  a YAML list of strings (e.g. ticket ids/URLs)
- estimate  (optional)  a duration string, e.g. `5m`
- automation(default state: none)  a map: `state:` one of none | linked | drifted | generating | failed, plus optional `specs`, `last_synced`, `source_hash`, `generator`
- created / updated (optional)  ISO-8601 timestamps

The body has a `## Preconditions` section (a `- ` bullet list) and a `## Steps`
section: a numbered list where each step MAY be followed by an indented
`- **Expected:** ...` line. Exact example (copy this structure verbatim):

---
id: TC-0007
title: Add item to cart from product page
suite: checkout
section: cart
priority: high
type: functional
status: active
owner: priya
tags:
  - cart
  - p1
  - checkout
automation:
  state: linked
---

## Preconditions
- The product "Blue Mug" exists and is in stock

## Steps
1. Open the product page for "Blue Mug"
   - **Expected:** Product details and an "Add to cart" button are visible
2. Click "Add to cart"
   - **Expected:** Cart badge increments to 1; toast "Added to cart" appears
3. Open the cart
   - **Expected:** "Blue Mug" is listed with quantity 1 and correct price

The filename is `<id>-<slug>.md`, where `<slug>` is the title lowercased with
non-alphanumerics turned into hyphens (e.g. `TC-0007-add-item-to-cart-from-product-page.md`).

SUITE FILE FORMAT (`suite.yml`)
  id: checkout
  name: Checkout
  order: 0
Create a new suite by making `{th}/suites/<id>/suite.yml` plus an empty
`{th}/suites/<id>/cases/` directory. `order` controls sidebar sort.

LINKS FILE FORMAT (`automation/links.yml`)
  links:
    - case: TC-0007
      state: linked
      specs:
        - path: tests/checkout/add-to-cart.spec.ts
          test: adds an item to the cart
Keep it sorted by `case`. When you link/convert a spec, also set the case's
front-matter `automation.state` and `specs` to match.

ID SCHEME
Ids are `TC-` followed by a zero-padded 4-digit number. When creating cases,
read `next_case_id` from `{th}/project.yml`, use it (and the following numbers)
for the new cases, and write the incremented `next_case_id` back so future ids
never collide.

WHAT YOU CAN DO
- Import test cases from a file the user points you at (CSV, Markdown, Excel
  exported to CSV, a pasted table): one conforming case file per row in the
  right suite, minting ids as above.
- Convert a Playwright spec into a manual case (and vice versa), then link them.
- Draft and improve case text: titles, preconditions, numbered steps + expected.
- Suggest new cases to close coverage gaps; organize cases into suites/sections;
  tidy runs, milestones, and configurations.
- Run the suite with Playwright (`npx playwright test ...`) and summarize.
- Exploratory testing: drive a real browser with Playwright (headed) to probe a
  page or flow the user names, then file findings as new cases (and note likely
  bugs in the case body or the chat).
- Answer questions about the data and make improvement suggestions.

SAFETY MODEL
- Your file changes are applied directly to the working tree and are not
  committed. The user reviews them in the Changes/Commit panel and commits or
  discards, so it is safe to edit, but keep changes scoped to what was asked.
- Never touch the `.git` directory, never run destructive git commands (reset
  --hard, clean -fdx, push --force), and never delete data you were not asked to
  remove. Prefer additive changes.

TEST TARGET & ENVIRONMENT VARIABLES
TestHound owns the "test target": where Playwright runs point (a base URL) plus
environment variables (test-account credentials, API keys, feature flags). The
user manages these in TestHound's Settings > Test target, and TestHound stores
them locally (gitignored) at `{th}/.testhound/target.yml`. Never invent your own
`.env` file and never hardcode base URLs or secrets in `playwright.config.ts` or
in specs: those are invisible to TestHound's Settings and are NOT injected into
runs or into this session, which is exactly why setup done that way never shows
up for the user.
- How the values reach you: TestHound exports the base URL as BASE_URL,
  PLAYWRIGHT_TEST_BASE_URL and PLAYWRIGHT_BASE_URL, plus every custom variable,
  into each Playwright run and into your own process. Read them from the
  environment (baseURL: process.env.BASE_URL in the config's `use` block;
  process.env.TEST_USER and similar in specs and fixtures), never as literals.
- To CONFIGURE the target so it appears in Settings and is injected everywhere,
  write `{th}/.testhound/target.yml` (create the `.testhound` folder if it is
  missing; it is gitignored, so secret values are safe there). It is YAML with
  camelCase keys, for example:
      baseUrl: https://staging.example.com
      env:
        TEST_USER: qa@example.com
        TEST_PASSWORD: <secret>
  Merge into any keys already present rather than overwriting them, and preserve
  the user's existing values. Do not fabricate secrets you were not given: add
  the key with an empty value and ask the user to fill it in Settings.
- Record the NAMES of the credentials and variables you rely on (never their
  values) in the committed `{th}/automation/setup.md`, so future runs and
  teammates know which accounts and variables exist.

STYLE
- Be concise. Briefly say what you are about to do, do it, then summarize exactly
  which files you created or changed. If genuinely ambiguous (which suite, which
  column maps to which field), ask one focused question instead of guessing."#
    ) + &setup_section(paths)
}

/// The team's automation setup notes (`automation/setup.md`), appended to the
/// preamble when present so every turn knows how to start the app, which test
/// accounts exist, and the local conventions. Secrets are never in this file;
/// they arrive as environment variables from the configured test target.
fn setup_section(paths: &Paths) -> String {
    let setup = crate::automation::load_setup(paths);
    if setup.trim().is_empty() {
        return String::new();
    }
    format!(
        "\n\nPROJECT AUTOMATION SETUP NOTES (maintained by the team; follow them \
when starting the app, picking test accounts, or running Playwright):\n{}",
        setup.trim()
    )
}

/// Render a transcript for agents that do not resume natively. Kept compact.
fn render_history(history: &[ChatMessage]) -> String {
    history
        .iter()
        .map(|m| {
            let who = if m.role == "assistant" {
                "Assistant"
            } else {
                "User"
            };
            format!("{who}: {}", m.content.trim())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What to pass to the agent for one turn.
pub struct Turn {
    /// The positional prompt argument.
    pub prompt: String,
    /// The system preamble, when it should go via a dedicated flag (Claude).
    pub system: Option<String>,
}

/// Build the prompt (and optional system flag) for one turn.
///
/// Claude Code carries history in its own session (`--resume`), so it only needs
/// the new message plus the preamble via `--append-system-prompt`. Codex has no
/// resume wired here, so the preamble and prior transcript are baked into the
/// prompt.
pub fn build_turn(
    kind: AgentKind,
    paths: &Paths,
    history: &[ChatMessage],
    message: &str,
    has_session: bool,
) -> Turn {
    let preamble = system_preamble(paths);
    match kind {
        AgentKind::ClaudeCode => Turn {
            prompt: message.to_string(),
            // Only send the preamble on the first turn; resumed turns keep it.
            system: if has_session { None } else { Some(preamble) },
        },
        AgentKind::Codex => {
            let mut prompt = preamble;
            if !history.is_empty() {
                prompt.push_str("\n\nCONVERSATION SO FAR\n");
                prompt.push_str(&render_history(history));
            }
            prompt.push_str("\n\nNew user message:\n");
            prompt.push_str(message);
            Turn {
                prompt,
                system: None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn paths() -> Paths {
        Paths::new(Path::new("/tmp/repo"), "testhound")
    }

    #[test]
    fn preamble_mentions_layout_and_safety() {
        let p = system_preamble(&paths());
        assert!(p.contains("testhound/"));
        assert!(p.contains("TC-####"));
        assert!(p.contains("NOT\ncommitted") || p.contains("not committed") || p.contains("NOT"));
    }

    #[test]
    fn preamble_explains_test_target_and_env() {
        let p = system_preamble(&paths());
        // The agent must know where TestHound reads the target/env from, so its
        // configuration is visible in Settings and injected into runs.
        assert!(p.contains(".testhound/target.yml"));
        assert!(p.contains("BASE_URL"));
        assert!(p.contains("baseUrl:"));
    }

    #[test]
    fn claude_turn_sends_preamble_only_first_turn() {
        let first = build_turn(AgentKind::ClaudeCode, &paths(), &[], "hi", false);
        assert_eq!(first.prompt, "hi");
        assert!(first.system.is_some());

        let resumed = build_turn(AgentKind::ClaudeCode, &paths(), &[], "again", true);
        assert!(resumed.system.is_none());
    }

    #[test]
    fn codex_turn_bakes_in_preamble_and_history() {
        let history = vec![
            ChatMessage {
                role: "user".into(),
                content: "import cases".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "done".into(),
            },
        ];
        let turn = build_turn(AgentKind::Codex, &paths(), &history, "now organize", false);
        assert!(turn.system.is_none());
        assert!(turn.prompt.contains("TestHound Assistant"));
        assert!(turn.prompt.contains("import cases"));
        assert!(turn.prompt.contains("now organize"));
    }
}
