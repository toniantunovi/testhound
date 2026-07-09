//! The agent runner abstraction (docs/05-ai-automation.md §5.1).
//!
//! Both supported agents are local CLI subprocesses invoked in headless,
//! non-interactive mode with the repo as their working directory. TestHound is
//! agent-agnostic: the only things that differ per agent are the executable
//! name and the argument vector, both produced by pure functions here so they
//! can be unit-tested without a live install. The only side-effecting entry
//! point is [`run`], which spawns the process and streams its output.

use crate::error::{Error, Result};
use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};

/// A supported coding agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    ClaudeCode,
    Codex,
}

impl AgentKind {
    /// Stable id used across the IPC boundary and in `generator` metadata.
    pub fn id(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude-code",
            AgentKind::Codex => "codex",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::Codex => "Codex",
        }
    }

    /// The executable we look for on `PATH` and spawn.
    pub fn command(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude",
            AgentKind::Codex => "codex",
        }
    }

    pub const ALL: [AgentKind; 2] = [AgentKind::ClaudeCode, AgentKind::Codex];

    pub fn from_id(id: &str) -> Option<AgentKind> {
        AgentKind::ALL.into_iter().find(|k| k.id() == id)
    }
}

/// Whether a given agent CLI is installed, for the picker in the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAvailability {
    pub id: String,
    pub name: String,
    pub command: String,
    pub available: bool,
}

/// Report which agents are installed on `PATH`.
pub fn detect_agents() -> Vec<AgentAvailability> {
    AgentKind::ALL
        .into_iter()
        .map(|k| AgentAvailability {
            id: k.id().to_string(),
            name: k.display_name().to_string(),
            command: k.command().to_string(),
            available: on_path(k.command()),
        })
        .collect()
}

/// Is `program` an executable somewhere on `PATH`? A pure filesystem lookup so
/// probing an agent never spawns it.
fn on_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    // On Windows an executable may carry one of the PATHEXT extensions.
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&path).any(|dir| {
        exts.iter().any(|ext| {
            let candidate = dir.join(format!("{program}{ext}"));
            candidate.is_file()
        })
    })
}

/// What we ask an agent to do; shapes the argument vector and permissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The agent must edit files in the workspace (generate/update a spec).
    Edit,
    /// The agent only reasons and prints an answer (failure triage); no writes.
    ReadOnly,
}

/// Build the argument vector for an agent invocation. Pure so the exact flags
/// are pinned by tests. The prompt is passed as the final positional argument.
///
/// Claude Code runs headless (`-p`) with an allow-list scoped to file edits and
/// running Playwright; Codex runs in non-interactive `exec` mode. Read-only
/// invocations drop write permissions entirely.
pub fn build_args(kind: AgentKind, mode: Mode, prompt: &str) -> Vec<String> {
    let s = |v: &str| v.to_string();
    match kind {
        AgentKind::ClaudeCode => {
            let mut args = vec![s("-p")];
            match mode {
                Mode::Edit => {
                    args.push(s("--permission-mode"));
                    args.push(s("acceptEdits"));
                    args.push(s("--allowedTools"));
                    // Space-joined tool list; Bash restricted to Playwright.
                    args.push(s("Edit Write Read Bash(npx playwright:*)"));
                }
                Mode::ReadOnly => {
                    args.push(s("--allowedTools"));
                    args.push(s("Read"));
                }
            }
            args.push(prompt.to_string());
            args
        }
        AgentKind::Codex => {
            let mut args = vec![s("exec")];
            match mode {
                // `--full-auto` lets Codex edit within the sandboxed workspace.
                Mode::Edit => args.push(s("--full-auto")),
                // Read-only: no workspace writes.
                Mode::ReadOnly => {
                    args.push(s("--sandbox"));
                    args.push(s("read-only"));
                }
            }
            args.push(prompt.to_string());
            args
        }
    }
}

/// Run an agent to completion in `workdir`, streaming each line of combined
/// output through `on_line`. Returns the concatenated stdout (used as the
/// suggestion text for read-only triage runs). Errors if the CLI is missing or
/// exits non-zero.
pub fn run<F: FnMut(&str)>(
    workdir: &Path,
    kind: AgentKind,
    mode: Mode,
    prompt: &str,
    mut on_line: F,
) -> Result<String> {
    if !on_path(kind.command()) {
        return Err(Error::Agent(format!(
            "{} CLI (`{}`) was not found on PATH",
            kind.display_name(),
            kind.command()
        )));
    }
    let args = build_args(kind, mode, prompt);
    on_line(&format!("$ {} {}", kind.command(), redact(&args)));

    let mut child = Command::new(kind.command())
        .args(&args)
        .current_dir(workdir)
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Agent(format!("failed to launch {}: {e}", kind.command())))?;

    // Read stderr to a file-free buffer on a thread so a chatty stderr can't
    // deadlock the stdout pipe.
    let stderr = child.stderr.take();
    let stderr_handle = stderr.map(|err| {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let mut lines = Vec::new();
            for line in BufReader::new(err).lines().map_while(std::result::Result::ok) {
                lines.push(line);
            }
            lines
        })
    });

    let mut captured = String::new();
    if let Some(out) = child.stdout.take() {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
            captured.push_str(&line);
            captured.push('\n');
            on_line(&line);
        }
    }

    let status = child
        .wait()
        .map_err(|e| Error::Agent(format!("agent did not exit cleanly: {e}")))?;

    if let Some(handle) = stderr_handle {
        if let Ok(lines) = handle.join() {
            for line in lines.iter().filter(|l| !l.trim().is_empty()) {
                on_line(line);
            }
        }
    }

    if !status.success() {
        return Err(Error::Agent(format!(
            "{} exited with {}",
            kind.display_name(),
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        )));
    }
    Ok(captured)
}

/// Collapse the (potentially long) prompt argument for the echoed command line.
fn redact(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if a.len() > 60 {
                format!("\"<prompt {} chars>\"", a.len())
            } else if a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_ids_round_trip() {
        for k in AgentKind::ALL {
            assert_eq!(AgentKind::from_id(k.id()), Some(k));
        }
        assert_eq!(AgentKind::from_id("nope"), None);
    }

    #[test]
    fn claude_edit_args_scope_tools() {
        let args = build_args(AgentKind::ClaudeCode, Mode::Edit, "do it");
        assert_eq!(args.first().unwrap(), "-p");
        assert!(args.contains(&"acceptEdits".to_string()));
        let i = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert!(args[i + 1].contains("Write"));
        assert!(args[i + 1].contains("Bash(npx playwright:*)"));
        // Prompt is the final positional argument.
        assert_eq!(args.last().unwrap(), "do it");
    }

    #[test]
    fn claude_readonly_args_drop_writes() {
        let args = build_args(AgentKind::ClaudeCode, Mode::ReadOnly, "why did it fail");
        let i = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(args[i + 1], "Read");
        assert!(!args.iter().any(|a| a == "acceptEdits"));
    }

    #[test]
    fn codex_modes() {
        let edit = build_args(AgentKind::Codex, Mode::Edit, "p");
        assert_eq!(edit.first().unwrap(), "exec");
        assert!(edit.contains(&"--full-auto".to_string()));

        let ro = build_args(AgentKind::Codex, Mode::ReadOnly, "p");
        let i = ro.iter().position(|a| a == "--sandbox").unwrap();
        assert_eq!(ro[i + 1], "read-only");
    }

    #[test]
    fn redact_hides_long_prompt() {
        let out = redact(&["-p".into(), "x".repeat(100)]);
        assert!(out.contains("<prompt 100 chars>"));
    }
}
