<p align="center">
  <img src="src-tauri/icons/icon.png" alt="TestHound" width="160" />
</p>

<h1 align="center">TestHound</h1>

<p align="center">A Git-native, AI-powered test management desktop app.</p>

TestHound is a TestRails alternative built as a Tauri desktop app. It stores every artifact (test cases, suites, runs, results, configuration) as plain files inside your Git repository, and uses coding agents (Claude Code and Codex) to generate and execute Playwright automated tests, keeping manual test cases and their automation linked.

## Why TestHound

- **The repository is the database.** Every test case, suite, run, and result is a human-readable file (Markdown + YAML/JSON front matter) committed to your repo. Branch, diff, review, and revert like any other code.
- **Manual and automated stay in sync.** Manual cases link to Playwright specs, with drift detection when a case changes.
- **Agents do the repetitive work.** Claude Code or Codex draft and maintain Playwright specs and help triage failures.
- **No lock-in.** Deleting TestHound leaves a fully usable, documented repo.

## Status

Milestones **M0 (Foundations)**, the core of **M1 (Git-native test management)**, **M2 (Runs & results)**, **M3 (Playwright execution)**, **M4 (AI automation)**, and **M5 (Collaboration polish)** are implemented: the Tauri v2 app scaffolds/opens a `testhound/` repo, reads and writes the file format, and ships the app shell, Dashboard, Test Cases list, and Test Case editor. M2 adds runs (built from a suite, a filter query, or a hand-picked set), manual result recording with per-case history, milestones and configurations, and a dashboard wired to real run data. M3 detects the project's Playwright install, runs the specs linked to a run's cases (`--grep` by test title, `--project` per configuration), streams live output to the Activity console, parses the JSON reporter, and ingests results as automated outcomes with elapsed times and evidence, including "Open trace" in the trace viewer. M4 adds the agent runner (Claude Code and Codex, invoked headless with a tests-scoped write allow-list): generate or update a Playwright spec from a manual case, review the result in a diff and accept it to link the spec (front matter + `automation/links.yml`), automatic drift detection on every case edit, a Coverage view (per-case automation state, orphan specs, and metrics), and agent-assisted failure triage on failed automated results. M5 adds the collaboration layer: a **semantic 3-way merge** that turns a conflicted case file into a field- and step-level resolver (pick base/ours/theirs per field, then write a clean file and stage it), `next_case_id` collision detection with a renumber-and-relink fix, opt-in **Git LFS** tracking for heavy evidence, a **PR-diff GitHub Action** that renders human-readable case-change summaries as a PR comment, cross-platform release builds (macOS/Windows/Linux via `tauri-action`), and a signed **auto-updater** surfaced in Settings. M6 finishes the designed Git-workflow UI at Figma fidelity: a **Changes / Commit** panel (changed files grouped semantically into cases/specs/results/automation, a per-file diff, a drafted commit message you can regenerate, and commit / commit-and-push), **Test Case History & Diff** (the commit timeline for a case with a per-commit diff, blame, restore-this-version, and a drift callout when an edit changed step expectations), a **⌘K command palette**, and a live repo bar (branch switcher, fast-forward **Sync**, and an uncommitted-changes indicator that opens the Changes panel).

## Running

```bash
pnpm install
pnpm app:dev      # launch the desktop app (Vite + Tauri)
```

Other scripts:

```bash
pnpm build                       # typecheck + build the frontend
pnpm app:build                   # build a distributable desktop bundle
(cd src-tauri && cargo test)     # Rust unit + integration tests
```

On first launch, the onboarding screen connects a local Git repo. If it has no `testhound/` directory, TestHound scaffolds one; check "Seed with sample data" to load the Acme Shop demo used in the Figma design.

## Architecture

- **`src-tauri/`** – Rust core. Layered as `domain` (pure types + step parsing), `repo` (on-disk serialization, scaffolding, drift), `git` (status/branch via `git2`), `playwright` (spec planning, JSON-report parsing, result ingestion, execution), `automation` (agent runner, prompt building, `links.yml`, coverage, accept flow), and `app` (Tauri commands + state). See `docs/02-architecture.md`.
- **`src/`** – React + TypeScript frontend (Vite, Tailwind with the design tokens, TanStack Query over IPC, Zustand session state).

## Releases & auto-update

TestHound is distributed via [GitHub Releases](https://github.com/toniantunovi/testhound/releases).
Pushing a `v*` tag on `main` triggers `.github/workflows/release.yml`, which
builds TestHound for macOS (Apple Silicon + Intel), Windows, and Linux with
`tauri-action`, signs the update artifacts, and publishes a GitHub Release
including the `latest.json` manifest the in-app updater reads.

The updater (Settings -> Updates) checks
`releases/latest/download/latest.json` and installs signed updates in place.
The signing private key lives in the `TAURI_SIGNING_PRIVATE_KEY` repo secret;
the matching public key is committed in `src-tauri/tauri.conf.json`.

To cut a release, bump `version` in `src-tauri/tauri.conf.json`, commit on
`main`, and tag it:

```bash
git tag v0.2.0
git push origin v0.2.0
```

To enable signed updates for a fork: generate a keypair with
`pnpm tauri signer generate -w ~/.tauri/testhound.key`, replace
`plugins.updater.pubkey` and the endpoint owner/repo in
`src-tauri/tauri.conf.json`, and set the `TAURI_SIGNING_PRIVATE_KEY` (and, if
the key has a password, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) repo secrets.

## Documentation

Design and specification documents live in `docs/` (not tracked in Git). The visual design lives in Figma: [TestHound](https://www.figma.com/design/RJe9VzT1kR0mCVSx0qWAep).
