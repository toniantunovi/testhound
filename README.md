# TestHound

A Git-native, AI-powered test management desktop app.

TestHound is a TestRails alternative built as a Tauri desktop app. It stores every artifact (test cases, suites, runs, results, configuration) as plain files inside your Git repository, and uses coding agents (Claude Code and Codex) to generate and execute Playwright automated tests, keeping manual test cases and their automation linked.

## Why TestHound

- **The repository is the database.** Every test case, suite, run, and result is a human-readable file (Markdown + YAML/JSON front matter) committed to your repo. Branch, diff, review, and revert like any other code.
- **Manual and automated stay in sync.** Manual cases link to Playwright specs, with drift detection when a case changes.
- **Agents do the repetitive work.** Claude Code or Codex draft and maintain Playwright specs and help triage failures.
- **No lock-in.** Deleting TestHound leaves a fully usable, documented repo.

## Status

Specification and design phase. No implementation code yet.

## Documentation

Design and specification documents live in `docs/` (not tracked in Git). The visual design lives in Figma: [TestHound](https://www.figma.com/design/RJe9VzT1kR0mCVSx0qWAep).
