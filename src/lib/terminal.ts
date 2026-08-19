// The one xterm instance the app has, and the wiring between it and the pty in Rust.
//
// It lives here, at module scope, rather than inside the React component, for one
// reason: a terminal has scrollback. Unmounting the panel (hiding it with ⌘J, or a
// StrictMode remount in dev) must not lose what the agent already printed. The pty
// itself lives in Rust for the same reason, so the two halves outlive the view together.
//
// The trick that makes it work is the holder: xterm renders once into a detached div,
// and mounting only moves that div into the panel.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, errMsg, type TermData, type TermExit } from "./ipc";

/** Matches tailwind.config.js, so the terminal reads as part of the app. */
const THEME = {
  background: "#0B0D10", // bg-base
  foreground: "#E6EAF0", // text-primary
  cursor: "#00D3A7", // brand-accent
  cursorAccent: "#0B0D10",
  selectionBackground: "#333A44", // border-strong
  black: "#14171C",
  red: "#F85149", // status-failed
  green: "#3FB950", // status-passed
  yellow: "#D29922", // status-blocked
  blue: "#6E8BFF", // brand-primary
  magenta: "#A371F7", // status-retest
  cyan: "#00D3A7", // brand-accent
  white: "#9AA4B2", // text-secondary
  brightBlack: "#5E6875", // text-muted
  brightRed: "#FF6B63",
  brightGreen: "#56D364",
  brightYellow: "#E3A008", // status-drifted
  brightBlue: "#8FA5FF",
  brightMagenta: "#BC8CFF",
  brightCyan: "#2EE7C0",
  brightWhite: "#F2F5F9",
};

interface Live {
  term: Terminal;
  fit: FitAddon;
  holder: HTMLDivElement;
  unlisten: UnlistenFn[];
  /** The pty this instance is showing, once `term_open` has answered. */
  session: number | null;
  /** An open in flight. Two mounts in one tick must not ask for two shells. */
  opening: Promise<void> | null;
  /** The last grid reported to the pty, so an unchanged one is not reported again. */
  grid: { cols: number; rows: number } | null;
  /** Sessions we killed. Their reader thread may still be draining; ignore it. */
  dead: Set<number>;
  exited: boolean;
  /** The agent id the running session was started for. */
  agent: string;
}

let live: Live | null = null;
let onExitChange: (exited: boolean) => void = () => {};
/** Fires on the first byte of a burst, and again once the pty has been quiet. `worked`
 *  says whether the burst was long enough to have been the agent doing something. */
let onActivity: (running: boolean, worked: boolean) => void = () => {};
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let burstStart = 0;

/** How long the pty must be quiet before the app treats the agent as done. There is
 *  no "turn finished" event in a terminal: a TUI stops emitting when it is waiting
 *  for input, and that is the only signal available. Long enough not to fire between
 *  two frames of a spinner, short enough that the Changes list feels live. */
const IDLE_MS = 1500;

/** A burst shorter than this was a keypress echo or a single TUI redraw, not work.
 *  Without the distinction, pausing while typing would invalidate every query on the
 *  screen beside the panel once per pause. */
const WORK_MS = 1200;

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function markBusy() {
  if (idleTimer === null) {
    burstStart = Date.now();
    onActivity(true, false);
  } else {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // The timer itself accounts for IDLE_MS of the elapsed time; the rest is output.
    onActivity(false, Date.now() - burstStart - IDLE_MS >= WORK_MS);
  }, IDLE_MS);
}

function create(): Live {
  const term = new Terminal({
    theme: THEME,
    fontFamily:
      '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", monospace',
    fontSize: 12,
    lineHeight: 1.3,
    cursorBlink: true,
    // An agent TUI redraws a tall frame; a generous buffer keeps the earlier turns.
    scrollback: 20_000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    // The pty is the authority on echo and wrapping. Convert nothing on the way in.
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const holder = document.createElement("div");
  holder.style.width = "100%";
  holder.style.height = "100%";
  term.open(holder);

  const l: Live = {
    term,
    fit,
    holder,
    unlisten: [],
    session: null,
    opening: null,
    grid: null,
    dead: new Set(),
    exited: false,
    agent: "",
  };

  // Keys and pasted text, straight through to the pty.
  term.onData((data) => {
    void api.termWrite(toBase64(enc.encode(data))).catch(() => {});
  });
  // Mouse reports and other already-byte-shaped output.
  term.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    void api.termWrite(toBase64(bytes)).catch(() => {});
  });

  void listen<TermData>("term://data", (e) => {
    if (l.dead.has(e.payload.id)) return;
    l.term.write(fromBase64(e.payload.base64));
    markBusy();
  }).then((un) => l.unlisten.push(un));

  void listen<TermExit>("term://exit", (e) => {
    if (l.dead.has(e.payload.id)) return;
    l.exited = true;
    onExitChange(true);
    l.term.write(
      `\r\n\x1b[38;5;242m[session ended${
        e.payload.code ? `, exit ${e.payload.code}` : ""
      }]\x1b[0m\r\n`,
    );
  }).then((un) => l.unlisten.push(un));

  return l;
}

/**
 * Draw the terminal into `container` and make sure a pty is running behind it.
 *
 * Safe to call repeatedly: the second call reattaches the same instance rather than
 * starting a second shell. Changing `agent` restarts the session, because the agent
 * is the command the shell was started with.
 */
export async function attach(
  container: HTMLElement,
  agent: string,
  handlers: {
    onExit: (exited: boolean) => void;
    onBusy: (busy: boolean, worked: boolean) => void;
  },
) {
  live ??= create();
  onExitChange = handlers.onExit;
  onActivity = handlers.onBusy;
  if (live.holder.parentElement !== container) container.appendChild(live.holder);
  refit();
  handlers.onExit(live.exited);
  if (live.session !== null && live.agent !== agent) {
    await restart(agent);
    return;
  }
  await open(agent);
}

/** Take the terminal out of the DOM without losing it. */
export function detach() {
  live?.holder.remove();
}

/**
 * Make sure a pty is running. Concurrent callers share one attempt, because the panel
 * mounts twice under StrictMode and two `term_open` calls in the same tick would race.
 */
function open(agent: string): Promise<void> {
  const l = live;
  if (!l) return Promise.resolve();
  if (l.session !== null) return Promise.resolve();
  l.opening ??= (async () => {
    try {
      l.session = await api.termOpen(l.term.cols, l.term.rows, agent);
      l.agent = agent;
      l.exited = false;
      onExitChange(false);
      markBusy();
    } catch (e) {
      l.term.write(`\r\n\x1b[38;5;203m${errMsg(e)}\x1b[0m\r\n`);
      l.exited = true;
      onExitChange(true);
    } finally {
      l.opening = null;
    }
  })();
  return l.opening;
}

/** Kill the shell and start a fresh one, agent command and all. */
export async function restart(agent: string) {
  if (!live) return;
  if (live.session !== null) live.dead.add(live.session);
  live.session = null;
  await api.termClose().catch(() => {});
  live.term.reset();
  await open(agent);
  live.term.focus();
}

/**
 * Put `text` in front of the agent, the way a paste would.
 *
 * This is how a Generate button reaches the terminal. `submit: false` leaves the text
 * on the prompt for the user to read and send, which is what staging a prompt means
 * when there is no composer to stage it in.
 */
export function type(text: string, submit: boolean) {
  if (!live) return;
  // Bracketed paste, so a multi-line prompt arrives as one block rather than as a
  // series of Enter presses that a TUI would each treat as a submit.
  const payload = `\x1b[200~${text.replace(/\r?\n/g, "\n")}\x1b[201~${submit ? "\r" : ""}`;
  void api.termWrite(toBase64(enc.encode(payload))).catch(() => {});
  live.term.focus();
}

/**
 * Re-measure and tell the pty. A no-op while the panel is hidden and has no size.
 *
 * Only a changed grid reaches Rust. Dragging the panel edge fires the observer every
 * frame, and most of those frames land inside the same character cell: a resize per
 * frame would send `SIGWINCH` at 60Hz and make the TUI redraw itself to death.
 */
export function refit() {
  if (!live || live.holder.clientWidth < 8 || live.holder.clientHeight < 8) return;
  try {
    live.fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = live.term;
  if (cols === live.grid?.cols && rows === live.grid?.rows) return;
  live.grid = { cols, rows };
  void api.termResize(cols, rows).catch(() => {});
}

export function focus() {
  live?.term.focus();
}

export function clear() {
  live?.term.clear();
}
