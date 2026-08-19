//! An interactive terminal, running inside the opened repository.
//!
//! This is a real pty with a real shell in it, not a transcript view. The app opens one,
//! types the agent's command into it, and from then on the bytes flow both ways
//! untouched: the full Claude Code (or Codex) TUI, its own key handling, its own
//! permission prompts, its plan mode and its slash commands, plus a shell to fall back
//! to when it exits.
//!
//! **This is a different trust model from [`crate::assistant`].** That runner spawns
//! `claude -p` with a fixed allow-list, which makes "the agent edits test data, the app
//! decides what is linked" a capability boundary rather than an instruction. A terminal
//! has no such boundary: whatever the user can do in a shell in that repository, this
//! agent can do. It is here because the user asked for a terminal, and it is the user's
//! own terminal. The allow-listed runner stays for anything TestHound drives on its own.
//!
//! The pty outlives the panel it is drawn in: the process lives in `AppState`, so
//! switching screens, or hiding the panel, does not kill a running session.

use crate::automation::agent::AgentKind;
use crate::error::{Error, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Overrides the whole startup line, so a developer can drive the same panel with a
/// plain shell, or with different flags, without a rebuild.
const COMMAND_ENV: &str = "TESTHOUND_TERM_COMMAND";

/// Emitted for every chunk the pty produces. Base64 because a chunk boundary can fall
/// inside a UTF-8 sequence or an escape sequence; xterm reassembles the stream itself.
#[derive(Serialize, Clone)]
pub struct TermData {
    pub id: u64,
    pub base64: String,
}

#[derive(Serialize, Clone)]
pub struct TermExit {
    pub id: u64,
    pub code: Option<i32>,
}

/// One live pty. Dropping it closes the master, which hangs up the shell.
pub struct Terminal {
    id: u64,
    /// Which agent this session was started for, so the panel can restart on a change.
    agent: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl Terminal {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn agent(&self) -> &str {
        &self.agent
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer
            .write_all(bytes)
            .and_then(|_| self.writer.flush())
            .map_err(|e| Error::Agent(format!("terminal input failed: {e}")))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(size(cols, rows))
            .map_err(|e| Error::Agent(format!("terminal resize failed: {e}")))
    }

    pub fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        // A zero here makes the shell think the window has no room and wrap everything
        // into column one, which is the classic "why is the TUI corrupt" bug.
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Single-quote a path for the shell line we type into the pty.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Read the whole context file, in the syntax of the shell we are typing into.
///
/// Both shells are quoted the same way for single-quoted literals (PowerShell doubles an
/// embedded quote, POSIX closes and reopens), so the quoting is done per shell too.
fn read_context(context: &str) -> String {
    if cfg!(windows) {
        format!("(Get-Content -Raw '{}')", context.replace('\'', "''"))
    } else {
        format!("\"$(cat {})\"", sh_quote(context))
    }
}

/// The startup line for `kind`, as typed, given the repo-relative path of the standing
/// context file written by [`crate::app`].
///
/// The context is the same TestHound preamble the allow-listed runner passes as a system
/// prompt: without it the agent would have to reverse-engineer the case file format from
/// the repository. Claude Code takes it as an appended system prompt; Codex has no such
/// flag interactively, so it is pointed at the file and reads it on its first turn.
pub fn startup_command(kind: AgentKind, context: &str) -> String {
    if let Ok(custom) = std::env::var(COMMAND_ENV) {
        if !custom.trim().is_empty() {
            return custom;
        }
    }
    match kind {
        AgentKind::ClaudeCode => format!(
            "claude --dangerously-skip-permissions --append-system-prompt {}",
            read_context(context)
        ),
        // Codex takes an opening prompt rather than a system prompt, so the file is
        // named rather than inlined: it reads it with its own tool on the first turn.
        AgentKind::Codex => format!(
            "codex --full-auto \"Read {} first: it is your standing context for this \
TestHound repository. Then briefly say you are ready and wait for my request.\"",
            context.replace('"', "")
        ),
    }
}

/// The shell to run. An interactive login shell, so the user's own `PATH` applies and
/// the session behaves exactly like the same terminal outside the app.
fn shell() -> String {
    // PowerShell rather than cmd.exe: the startup line reads the context file, and
    // `cmd` has no command substitution to read it with.
    if cfg!(windows) {
        return "powershell.exe".to_string();
    }
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

/// Open a pty in `cwd`, pump its output into `on_data`, and type `command` into it.
/// `on_exit` fires once, when the shell is gone.
///
/// `env` carries the configured test target (base URL, credentials), so a Playwright run
/// the agent starts from this terminal points at the same app as one TestHound starts.
///
/// Both callbacks receive the session id, so a stale reader thread draining a killed
/// session cannot paint into the terminal that replaced it. Taking sinks rather than an
/// `AppHandle` keeps the pty wiring testable without a running app.
pub fn spawn(
    cwd: &Path,
    agent: &str,
    command: &str,
    cols: u16,
    rows: u16,
    env: &[(String, String)],
    on_data: impl Fn(u64, &[u8]) + Send + 'static,
    on_exit: impl Fn(u64, Option<i32>) + Send + 'static,
) -> Result<Terminal> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    let pty = portable_pty::native_pty_system();
    let pair = pty
        .openpty(size(cols, rows))
        .map_err(|e| Error::Agent(format!("could not open a pty: {e}")))?;

    let mut cmd = CommandBuilder::new(shell());
    if cfg!(windows) {
        cmd.arg("-NoLogo");
    } else {
        cmd.arg("-i");
        cmd.arg("-l");
    }
    cmd.cwd(cwd);
    // The TUI asks the terminal what it can do. xterm.js answers as a 256-colour xterm.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Read by agent CLIs to decide whether they may draw colour over the screen.
    cmd.env("FORCE_COLOR", "1");
    for (k, v) in env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| Error::Agent(format!("could not start a shell: {e}")))?;
    // The slave end must be closed here, or reading the master never sees EOF when the
    // shell exits and the reader thread hangs forever.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| Error::Agent(format!("could not read the pty: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| Error::Agent(format!("could not write the pty: {e}")))?;

    let child = Arc::new(Mutex::new(child));

    // Reader: pty to frontend, until EOF.
    {
        let mut reader = reader;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_data(id, &buf[..n]),
                }
            }
        });
    }

    // Reaper: report the exit code once, so the panel can offer a restart instead of
    // looking like a terminal that stopped accepting keys.
    {
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            // Polled rather than blocking: `wait` holds the lock, and `kill` needs it.
            let code = loop {
                let status = child
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok().flatten());
                match status {
                    Some(s) => break Some(s.exit_code() as i32),
                    None => std::thread::sleep(std::time::Duration::from_millis(120)),
                }
            };
            on_exit(id, code);
        });
    }

    let mut term = Terminal {
        id,
        agent: agent.to_string(),
        master: pair.master,
        writer,
        child,
    };
    term.write(format!("{command}\n").as_bytes())?;
    Ok(term)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn a_zero_dimension_never_reaches_the_pty() {
        let s = size(0, 0);
        assert_eq!((s.cols, s.rows), (1, 1));
    }

    #[test]
    #[cfg(unix)]
    fn the_shell_is_a_real_path() {
        assert!(shell().starts_with('/'), "{}", shell());
    }

    /// The point of the panel: a real terminal with the agent already in it, and the
    /// TestHound context handed to it rather than left to be guessed.
    #[test]
    fn the_startup_command_carries_the_standing_context() {
        let claude = startup_command(AgentKind::ClaudeCode, "testhound/.testhound/x.md");
        assert!(claude.starts_with("claude --dangerously-skip-permissions"), "{claude}");
        assert!(claude.contains("--append-system-prompt"), "{claude}");
        // The content, not a filename the agent has to be trusted to open.
        assert!(claude.contains("cat ") || claude.contains("Get-Content"), "{claude}");
        assert!(claude.contains("testhound/.testhound/x.md"), "{claude}");

        let codex = startup_command(AgentKind::Codex, "testhound/.testhound/x.md");
        assert!(codex.starts_with("codex --full-auto"), "{codex}");
        assert!(codex.contains("testhound/.testhound/x.md"), "{codex}");
    }

    #[test]
    #[cfg(unix)]
    fn a_path_with_a_quote_in_it_cannot_break_out_of_the_command() {
        let cmd = startup_command(AgentKind::ClaudeCode, "a'b; rm -rf /");
        assert!(cmd.contains(r"'a'\''b; rm -rf /'"), "{cmd}");
    }

    /// Collect pty output until `needle` shows up or the clock runs out.
    fn drain_until(rx: &mpsc::Receiver<Vec<u8>>, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut seen = String::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk)),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if seen.contains(needle) {
                return seen;
            }
        }
        seen
    }

    /// The whole module, exercised for real: a shell starts in the given directory, the
    /// startup command runs in it without anyone typing, and it is still a terminal
    /// afterwards. No agent CLI is involved: a test must not depend on a logged-in CLI
    /// and must not burn tokens.
    #[test]
    #[cfg(unix)]
    fn the_startup_command_runs_by_itself_in_the_given_directory() {
        let dir = tempfile::tempdir().unwrap();
        // Resolved because macOS hands out /var/folders, a symlink to /private/var.
        let root = dir.path().canonicalize().unwrap();

        let (tx, rx) = mpsc::channel();
        let (extx, exrx) = mpsc::channel();
        // `pwd`, because a pty echoes what is typed into it: a needle that appears in
        // the command line itself would match the echo and prove nothing ran.
        let term = spawn(
            &root,
            "test",
            "pwd",
            100,
            30,
            &[("TH_MARKER".to_string(), "SET".to_string())],
            move |_, bytes| {
                let _ = tx.send(bytes.to_vec());
            },
            move |_, code| {
                let _ = extx.send(code);
            },
        )
        .unwrap();

        let seen = drain_until(&rx, root.to_str().unwrap());
        assert!(
            seen.contains(root.to_str().unwrap()),
            "the startup command did not run in the repo:\n{seen}"
        );

        // Typing into it reaches the shell, and the test-target environment is there.
        // The marker is assembled by the shell so it cannot match the input echo.
        let mut term = term;
        term.write(b"printf 'MARK%s\\n' \"-$TH_MARKER\"\n").unwrap();
        let seen = drain_until(&rx, "MARK-SET");
        assert!(seen.contains("MARK-SET"), "input or env never landed:\n{seen}");

        // Killing it reports an exit rather than leaving a terminal that ignores keys.
        term.kill();
        assert!(
            exrx.recv_timeout(Duration::from_secs(10)).is_ok(),
            "no exit was reported"
        );
    }
}
