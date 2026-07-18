<p align="center">
  <img src="src-tauri/icons/icon.png" alt="TestHound" width="160" />
</p>

<h1 align="center">TestHound</h1>

<p align="center">A Git-native, AI-powered test management desktop app.</p>

TestHound is a modern alternative to tools like TestRail, built as a Tauri desktop app. It stores every artifact (test cases, suites, runs, results, configuration) as plain files inside your Git repository, and it uses coding agents (Claude Code and Codex) to generate and maintain Playwright automated tests, keeping manual test cases and their automation linked.

## Why TestHound

- **The repository is the database.** Every test case, suite, run, and result is a human-readable file (Markdown with YAML/JSON front matter) committed to your repo. Branch, diff, review, and revert test artifacts like any other code.
- **Manual and automated stay in sync.** Manual cases link to Playwright specs, with automatic drift detection when a case changes.
- **Agents do the repetitive work.** Claude Code or Codex draft and maintain Playwright specs and help triage failures.
- **No lock-in.** Removing TestHound leaves behind a fully usable, documented repository.
- **Privacy by default.** TestHound sends only a strictly anonymous usage stream (a random install id and coarse counts, never your titles, paths, repos, or code). Turn it off in Settings, via Do-Not-Track, or with `TESTHOUND_TELEMETRY=0`. See [PRIVACY.md](PRIVACY.md).

## Features

### Test management
- Scaffolds or opens a `testhound/` directory in any Git repository and reads/writes the plain-file format.
- Dashboard, test case list, and a full test case editor with structured steps and expectations.
- Suites, milestones, and configurations.

### Runs and results
- Build runs from a suite, a filter query, or a hand-picked set of cases.
- Record manual results with per-case history; the dashboard reflects real run data.

### Playwright execution
- Detects the project's Playwright installation and runs the specs linked to a run's cases (`--grep` by test title, `--project` per configuration).
- Streams live output to an activity console, parses the JSON reporter, and ingests results as automated outcomes with elapsed times and evidence, including opening traces in the Playwright trace viewer.

### AI automation
- Agent runner for Claude Code and Codex, invoked headless with a write allow-list scoped to the tests directory.
- Generate or update a Playwright spec from a manual case, review the change as a diff, and accept it to link the spec to the case.
- Coverage view showing per-case automation state, orphan specs, and metrics.
- Agent-assisted triage of failed automated results.

### Collaboration and Git workflow
- Semantic 3-way merge: conflicted case files are resolved field by field and step by step (pick base, ours, or theirs), then written back clean and staged.
- Case ID collision detection with a renumber-and-relink fix.
- Opt-in Git LFS tracking for heavy evidence files.
- A GitHub Action that renders human-readable summaries of test case changes as a PR comment.
- Changes/commit panel with semantically grouped files, per-file diffs, and a drafted commit message; commit or commit-and-push from the app.
- Test case history with per-commit diffs, blame, and restore, plus a drift callout when an edit changed step expectations.
- Command palette (⌘K) and a live repo bar with branch switching, fast-forward sync, and an uncommitted-changes indicator.

## Install

**macOS and Linux**, one line:

```bash
curl -fsSL https://raw.githubusercontent.com/toniantunovi/testhound/main/install.sh | sh
```

The script detects your platform, downloads the matching build from the [latest release](https://github.com/toniantunovi/testhound/releases/latest), and installs it (macOS: `/Applications/TestHound.app`; Linux: `~/.local/bin/testhound`). Set `TESTHOUND_INSTALL_DIR` to choose a different macOS destination.

**Windows**: download the `.exe` installer (or `.msi`) from the [latest release](https://github.com/toniantunovi/testhound/releases/latest).

> **Note for manual macOS downloads:** release builds are not notarized yet, so after a browser download Gatekeeper reports the app as "damaged". That is a quarantine flag, not corruption. The install script handles it; for a manual download, copy the app to `/Applications` and run `xattr -cr /Applications/TestHound.app` once.

Once installed, the app keeps itself up to date via the in-app updater (Settings > Updates).

## Developing

Prerequisites: [Node.js](https://nodejs.org) with [pnpm](https://pnpm.io), and the [Tauri v2 toolchain](https://v2.tauri.app/start/prerequisites/) (Rust plus platform dependencies).

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

On first launch, the onboarding screen connects a local Git repository. If it has no `testhound/` directory, TestHound scaffolds one. Check "Seed with sample data" to explore the app with a demo project.

## Architecture

- **`src-tauri/`**: the Rust core, layered as `domain` (pure types and step parsing), `repo` (on-disk serialization, scaffolding, drift detection), `git` (status and branching via `git2`), `playwright` (spec planning, JSON report parsing, result ingestion, execution), `automation` (agent runner, prompt building, spec linking, coverage, accept flow), and `app` (Tauri commands and state).
- **`src/`**: the React + TypeScript frontend (Vite, Tailwind with design tokens, TanStack Query over IPC, Zustand for session state).

## Releases and auto-update

TestHound is distributed via [GitHub Releases](https://github.com/toniantunovi/testhound/releases). Pushing a `v*` tag on `main` triggers `.github/workflows/release.yml`, which builds TestHound for macOS (Apple Silicon and Intel), Windows, and Linux with `tauri-action`, signs the update artifacts, and publishes a GitHub Release including the `latest.json` manifest the in-app updater reads.

The updater (Settings > Updates) checks `releases/latest/download/latest.json` and installs signed updates in place.

To cut a release, bump `version` in `src-tauri/tauri.conf.json`, commit on `main`, and tag it:

```bash
git tag v0.2.0
git push origin v0.2.0
```

To enable signed updates for a fork: generate a keypair with `pnpm tauri signer generate -w ~/.tauri/testhound.key`, replace `plugins.updater.pubkey` and the endpoint owner/repo in `src-tauri/tauri.conf.json`, and set the `TAURI_SIGNING_PRIVATE_KEY` repo secret (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has a password).

macOS builds are ad-hoc signed until the Apple signing secrets are configured. To produce notarized builds, set the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` repo secrets (see the comments in `release.yml`); `tauri-action` then signs and notarizes automatically.

## License

TestHound is released under the [MIT License](LICENSE). Copyright © 2026 Voldeq GmbH.
