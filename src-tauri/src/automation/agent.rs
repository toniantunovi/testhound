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
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

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
            // The prompt goes immediately after `-p` (canonical
            // `claude -p "prompt" [flags]`). It must NOT trail `--allowedTools`,
            // which is variadic and would otherwise swallow it as a tool name,
            // leaving Claude with no prompt argument.
            let mut args = vec![s("-p"), prompt.to_string()];
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

// ---- Conversational (assistant panel) mode -----------------------------------
//
// The assistant panel is a multi-turn version of the one-shot runner above. It
// keeps the repo as the working directory and grants a broad, auto-accepting
// tool scope (the user opted into "git is the safety net"), so the agent can
// import files, convert specs, write and organize cases, run Playwright, and
// drive a headed browser for exploratory testing.

/// A high-level streamed event, normalized across agents so the UI does not
/// have to know each CLI's output shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatEvent {
    /// Assistant natural-language prose.
    Text(String),
    /// The agent invoked a tool; a short human summary (e.g. `Edit TC-0007.md`).
    Tool(String),
    /// A raw output line we could not classify (Codex, or unparsable Claude).
    Log(String),
    /// Terminal event carrying the resumable session id and final answer.
    Done {
        session_id: Option<String>,
        text: String,
        is_error: bool,
    },
}

/// The result of one conversational turn.
#[derive(Debug, Clone)]
pub struct ChatOutcome {
    /// The agent's final answer text.
    pub reply: String,
    /// A session id to pass to the next turn for continuity (Claude Code only).
    pub session_id: Option<String>,
}

/// Build the argument vector for one conversational turn. Pure, so the flags are
/// pinned by tests. Claude Code streams structured JSON (`stream-json`) and
/// resumes its own session; Codex gets the whole context baked into the prompt
/// by the caller since headless resume is not wired here.
pub fn build_chat_args(
    kind: AgentKind,
    prompt: &str,
    resume: Option<&str>,
    system: Option<&str>,
) -> Vec<String> {
    let s = |v: &str| v.to_string();
    match kind {
        AgentKind::ClaudeCode => {
            // Prompt immediately after `-p`, before any variadic flag such as
            // `--allowedTools` (which would otherwise consume it).
            let mut args = vec![
                s("-p"),
                prompt.to_string(),
                s("--output-format"),
                s("stream-json"),
                s("--verbose"),
                s("--permission-mode"),
                s("acceptEdits"),
                s("--allowedTools"),
                s("Read Edit Write Bash Glob Grep WebFetch"),
            ];
            if let Some(sys) = system {
                args.push(s("--append-system-prompt"));
                args.push(sys.to_string());
            }
            if let Some(id) = resume {
                args.push(s("--resume"));
                args.push(id.to_string());
            }
            args
        }
        AgentKind::Codex => vec![s("exec"), s("--full-auto"), prompt.to_string()],
    }
}

/// Turn one line of Claude Code `stream-json` output into zero or more
/// high-level [`ChatEvent`]s. Unparsable lines yield nothing (the caller may
/// still surface them as raw logs).
pub fn parse_claude_line(line: &str) -> Vec<ChatEvent> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return vec![];
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            let mut out = Vec::new();
            if let Some(content) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in content {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    out.push(ChatEvent::Text(t.to_string()));
                                }
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            out.push(ChatEvent::Tool(summarize_tool(name, block.get("input"))));
                        }
                        _ => {}
                    }
                }
            }
            out
        }
        Some("result") => {
            let session_id = v
                .get("session_id")
                .and_then(|s| s.as_str())
                .map(String::from);
            let text = v
                .get("result")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false)
                || v.get("subtype")
                    .and_then(|s| s.as_str())
                    .map(|s| s != "success")
                    .unwrap_or(false);
            vec![ChatEvent::Done {
                session_id,
                text,
                is_error,
            }]
        }
        _ => vec![],
    }
}

/// A short, human-readable summary of a tool invocation for the activity feed.
fn summarize_tool(name: &str, input: Option<&serde_json::Value>) -> String {
    let field = |key: &str| {
        input
            .and_then(|i| i.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let detail = field("file_path")
        .or_else(|| field("path"))
        .or_else(|| field("command"))
        .or_else(|| field("pattern"))
        .or_else(|| field("url"));
    match detail {
        Some(d) => {
            let d = if d.len() > 80 { format!("{}…", &d[..80]) } else { d };
            format!("{name}: {d}")
        }
        None => name.to_string(),
    }
}

/// Run one conversational turn to completion in `workdir`, forwarding each
/// [`ChatEvent`] through `on_event` as it arrives. Returns the final answer and
/// (for Claude Code) a session id to resume next turn.
pub fn run_chat<F: FnMut(ChatEvent)>(
    workdir: &Path,
    kind: AgentKind,
    prompt: &str,
    resume: Option<&str>,
    system: Option<&str>,
    child_slot: Arc<Mutex<Option<Child>>>,
    mut on_event: F,
) -> Result<ChatOutcome> {
    if !on_path(kind.command()) {
        return Err(Error::Agent(format!(
            "{} CLI (`{}`) was not found on PATH",
            kind.display_name(),
            kind.command()
        )));
    }
    let args = build_chat_args(kind, prompt, resume, system);

    let mut command = Command::new(kind.command());
    command
        .args(&args)
        .current_dir(workdir)
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Put the agent in its own process group so Stop can terminate the whole
    // tree (the CLI plus any Playwright/browser it spawned), not just the parent.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| Error::Agent(format!("failed to launch {}: {e}", kind.command())))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Register the running child so `assistant_stop` can terminate it mid-run.
    *child_slot.lock().unwrap() = Some(child);

    let stderr_handle = stderr.map(|err| {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            BufReader::new(err)
                .lines()
                .map_while(std::result::Result::ok)
                .collect::<Vec<_>>()
        })
    });

    let mut reply = String::new();
    let mut session_id = resume.map(String::from);
    let mut saw_error = false;

    if let Some(out) = stdout {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
            match kind {
                AgentKind::ClaudeCode => {
                    let events = parse_claude_line(&line);
                    if events.is_empty() {
                        continue;
                    }
                    for ev in events {
                        match ev {
                            ChatEvent::Text(t) => {
                                reply.push_str(&t);
                                reply.push('\n');
                                on_event(ChatEvent::Text(t));
                            }
                            ChatEvent::Done {
                                session_id: sid,
                                text,
                                is_error,
                            } => {
                                if sid.is_some() {
                                    session_id = sid;
                                }
                                if !text.trim().is_empty() {
                                    reply = text;
                                }
                                saw_error = is_error;
                            }
                            other => on_event(other),
                        }
                    }
                }
                AgentKind::Codex => {
                    reply.push_str(&line);
                    reply.push('\n');
                    on_event(ChatEvent::Log(line));
                }
            }
        }
    }

    // Reclaim the child to wait on it. If Stop already took it, we were
    // cancelled: return whatever streamed before the kill.
    let Some(mut child) = child_slot.lock().unwrap().take() else {
        return Ok(ChatOutcome {
            reply: reply.trim().to_string(),
            session_id,
        });
    };

    let status = child
        .wait()
        .map_err(|e| Error::Agent(format!("agent did not exit cleanly: {e}")))?;

    let stderr_lines = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    if !status.success() {
        let detail: String = stderr_lines
            .iter()
            .filter(|l| !l.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let reason = if detail.trim().is_empty() {
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into())
        } else {
            detail
        };
        return Err(Error::Agent(format!(
            "{} exited unsuccessfully: {reason}",
            kind.display_name()
        )));
    }

    if saw_error && reply.trim().is_empty() {
        return Err(Error::Agent(format!(
            "{} reported an error with no output",
            kind.display_name()
        )));
    }

    Ok(ChatOutcome {
        reply: reply.trim().to_string(),
        session_id,
    })
}

/// Terminate a running agent child and, on Unix, its whole process group, then
/// reap it. Used by the Stop control in the assistant panel.
pub fn kill_child(child: &mut Child) {
    #[cfg(unix)]
    {
        // A negative pid targets the process group created via `process_group`,
        // so tools the agent spawned (bash, Playwright, a browser) die too.
        let pid = child.id();
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(format!("-{pid}"))
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
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
        // Prompt sits right after `-p`, never trailing the variadic --allowedTools.
        assert_eq!(args[1], "do it");
        assert!(args.contains(&"acceptEdits".to_string()));
        let i = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert!(args[i + 1].contains("Write"));
        assert!(args[i + 1].contains("Bash(npx playwright:*)"));
        // Nothing follows the tool list that the CLI could mistake for a tool.
        assert_eq!(i + 1, args.len() - 1);
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

    #[test]
    fn chat_args_stream_json_and_resume() {
        let args = build_chat_args(AgentKind::ClaudeCode, "hi", Some("sess-1"), Some("ctx"));
        assert_eq!(args.first().unwrap(), "-p");
        // Prompt right after `-p`, before the variadic --allowedTools.
        assert_eq!(args[1], "hi");
        let fmt = args.iter().position(|a| a == "--output-format").unwrap();
        assert_eq!(args[fmt + 1], "stream-json");
        let res = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[res + 1], "sess-1");
        let sys = args.iter().position(|a| a == "--append-system-prompt").unwrap();
        assert_eq!(args[sys + 1], "ctx");
    }

    #[test]
    fn chat_args_first_turn_has_no_resume() {
        let args = build_chat_args(AgentKind::ClaudeCode, "hi", None, None);
        assert!(!args.iter().any(|a| a == "--resume"));
        assert!(!args.iter().any(|a| a == "--append-system-prompt"));
    }

    #[test]
    fn codex_chat_args_are_exec_full_auto() {
        let args = build_chat_args(AgentKind::Codex, "do it", None, Some("ignored"));
        assert_eq!(args, vec!["exec", "--full-auto", "do it"]);
    }

    #[test]
    fn parse_assistant_text_and_tool() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Working"},{"type":"tool_use","name":"Edit","input":{"file_path":"testhound/cases/TC-0007.md"}}]}}"#;
        let events = parse_claude_line(line);
        assert_eq!(events[0], ChatEvent::Text("Working".into()));
        assert_eq!(
            events[1],
            ChatEvent::Tool("Edit: testhound/cases/TC-0007.md".into())
        );
    }

    #[test]
    fn parse_result_captures_session_and_text() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"session_id":"abc","result":"Done"}"#;
        let events = parse_claude_line(line);
        assert_eq!(
            events[0],
            ChatEvent::Done {
                session_id: Some("abc".into()),
                text: "Done".into(),
                is_error: false,
            }
        );
    }

    #[test]
    fn parse_ignores_unrelated_lines() {
        assert!(parse_claude_line("not json").is_empty());
        assert!(parse_claude_line(r#"{"type":"system"}"#).is_empty());
    }
}
