# Privacy

TestHound is local-first and Git-native. Your test cases, suites, runs, results,
and specs are plain files in your own Git repository. TestHound has no accounts,
no server as a source of truth, and no access to your repository contents.

The one thing TestHound sends off your machine is a small, strictly anonymous
usage stream, so we can see which features land and decide what to build next.
This document says exactly what that is, and how to turn it off.

## What is collected

Anonymous product usage events, tied only to a random install id that is
generated once on your machine and is never linked to you or your work. Each
event carries only:

- `install_id`: a random UUID generated once per install. Not derived from
  anything about you, your machine, or your repository.
- `event`: the event name (see the list below).
- `app_version`, `os`: the TestHound version and OS family (`macos`,
  `windows`, `linux`).
- A handful of whitelisted numeric buckets and yes/no flags per event, listed
  below.

### The complete event list

| Event | Extra properties |
|---|---|
| `app_launched` | (none beyond the common ones) |
| `project_opened` | `is_new` (bool: was the project just scaffolded) |
| `case_created` | `count_bucket` (`"1"`, `"2-10"`, `"11-50"`, `"50+"`) |
| `run_created` | `case_count_bucket` (same buckets) |
| `result_recorded` | `source` (`"manual"` or `"playwright"`) |
| `spec_generated` | `agent` (`"claude-code"` / `"codex"`), `update` (bool) |
| `spec_accepted` | `agent` |
| `sync_performed` | `had_conflict` (bool) |

Counts are always sent as coarse buckets, never as the raw number.

## What is NEVER collected

TestHound never sends, and the code has no path to send:

- Case titles, descriptions, steps, or any test content.
- File paths, repository names or URLs, git remotes, or branch names.
- Source code or Playwright spec contents.
- Base URLs, environment variable names or values, or any secret.
- Your name, email, IP-derived identity, or any account identifier (there are
  no accounts).

TestHound has no accounts and asks for no email, so there is no contact
information to collect.

## How to turn it off

Telemetry is on by default (a transparent opt-out) and can be disabled at any
time, several ways:

- **In the app:** Settings, "Privacy & anonymous usage", turn it off. Nothing is
  sent while it is off.
- **Do Not Track:** if your system signals Do-Not-Track, TestHound sends nothing.
- **Environment variable:** set `TESTHOUND_TELEMETRY=0` (also accepts `false`,
  `off`, `no`) before launching TestHound.

## Where it goes

Events are sent to [PostHog](https://posthog.com) (US region). The project key
shipped in the app is a write-only capture key; it cannot read data back.
