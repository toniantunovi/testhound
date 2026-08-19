import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Eraser,
  PanelBottom,
  PanelRight,
  RotateCw,
  Terminal as TerminalIcon,
  TriangleAlert,
  X,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "@/lib/ipc";
import { track } from "@/lib/telemetry";
import * as term from "@/lib/terminal";
import type { AgentAvailability } from "@/lib/types";
import { useAssistant, type Dock } from "@/store/assistant";
import { cn } from "@/lib/utils";

/**
 * The assistant: a terminal, in the repository, with a coding agent already in it.
 *
 * It is a real pty running a real login shell, so it behaves the way the same terminal
 * would outside the app, including the agent's own TUI, its plan mode, its slash
 * commands, and the shell it hands the prompt back to when it exits. The startup line
 * carries the agent's skip-permissions flag, which is why the header shows the command:
 * nothing in this panel asks before it edits or runs anything.
 *
 * It docks beside a screen rather than replacing one, because the point of watching it
 * is watching what it does to the case list and the Changes panel next to it.
 *
 * That is a wider capability than the buttons around it. `assistant_send` spawns the
 * agent with a fixed allow-list, which is what keeps "the agent writes specs, TestHound
 * decides what is linked" enforced rather than promised, and it is still what TestHound
 * drives on its own. A terminal is the user's own terminal.
 */

/** Quote a dropped path for the prompt when it contains whitespace. */
function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

// Queries whose data the agent may have changed on disk. Invalidated whenever the
// terminal goes quiet, so the screen beside the panel keeps up with the agent.
const REFRESH_KEYS = [
  "cases",
  "suites",
  "runs",
  "dashboard",
  "coverage",
  "git-status",
  "conflicts",
  "playwright-info",
  "test-target",
  "automation-setup",
];

/** Mounted only while the panel is open, so the terminal effect always finds its host
 *  div on the first render. The pty and the scrollback outlive the mount either way. */
export function AssistantPanel() {
  const open = useAssistant((s) => s.open);
  return open ? <Panel /> : null;
}

function Panel() {
  const dock = useAssistant((s) => s.dock);
  const width = useAssistant((s) => s.width);
  const height = useAssistant((s) => s.height);
  const agentId = useAssistant((s) => s.agentId);
  const setAgent = useAssistant((s) => s.setAgent);
  const setDock = useAssistant((s) => s.setDock);
  const setOpen = useAssistant((s) => s.setOpen);
  const setBusy = useAssistant((s) => s.setBusy);
  const draft = useAssistant((s) => s.draft);
  const clearDraft = useAssistant((s) => s.clearDraft);
  const pendingSend = useAssistant((s) => s.pendingSend);
  const clearPendingSend = useAssistant((s) => s.clearPendingSend);

  const qc = useQueryClient();
  const host = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [exited, setExited] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // The agent's TUI has drawn and gone quiet, so it is listening. Typing a staged
  // prompt before this lands it in the shell's input buffer, where the agent's own
  // startup either eats it or receives half of it.
  const [ready, setReady] = useState(false);

  const right = dock === "right";

  // The terminal has no "turn finished" event, so a quiet pty is the only signal
  // there is: refresh the data-backed screens, and try to link a pending spec.
  const onBusy = useCallback(
    (busy: boolean, worked: boolean) => {
      setBusy(busy);
      if (busy) return;
      // The first quiet moment means the agent has finished starting up.
      setReady(true);
      // A burst too short to have been work was a keystroke echo; refreshing every
      // screen once per typing pause would be a lot of churn for nothing.
      if (!worked) return;
      REFRESH_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      // A generated spec is linked here, in code, so the agent never hand-edits the
      // case front matter (a malformed edit used to make the case vanish). If the
      // spec is not on disk yet the marker stays for the next quiet moment.
      const { pendingGeneration, agentId: generator, clearGeneration } =
        useAssistant.getState();
      if (!pendingGeneration) return;
      api
        .linkGeneratedSpecs(pendingGeneration.caseId, pendingGeneration.update, generator)
        .then((linked) => {
          if (!linked) return;
          // A generated spec was good enough to accept and link: the
          // differentiator-value signal.
          void track("spec_accepted", { agent: generator });
          clearGeneration();
          REFRESH_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        })
        .catch(() => {
          /* spec not linkable yet; keep the pending marker for next time */
        });
    },
    [qc, setBusy],
  );

  const restart = useCallback(() => {
    setReady(false);
    void term.restart(useAssistant.getState().agentId);
  }, []);

  // Which agent CLIs are installed. Re-run via "Check again" after the user installs
  // one; no app restart needed.
  const refreshAgents = useCallback(() => {
    void api.listAgents().then(setAgents);
  }, []);
  useEffect(() => {
    refreshAgents();
  }, [refreshAgents]);

  // The line the shell is given, straight from Rust, so the header cannot claim a
  // different command than the one that runs.
  useEffect(() => {
    void api
      .termCommand(agentId)
      .then(setCommand)
      .catch(() => setCommand(""));
  }, [agentId]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    void term.attach(el, agentId, { onExit: setExited, onBusy });
    const ro = new ResizeObserver(() => term.refit());
    ro.observe(el);
    return () => {
      ro.disconnect();
      // The pty keeps running; only the view goes away.
      term.detach();
    };
    // Mount only: the agent is handled by the effect below, so switching it does not
    // tear the holder out of the DOM and back in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching agent means a different command, which means a different shell.
  const mountedAgent = useRef(agentId);
  useEffect(() => {
    if (mountedAgent.current === agentId) return;
    mountedAgent.current = agentId;
    restart();
  }, [agentId, restart]);

  // Redocking moves the same terminal into a container of a different shape.
  useEffect(() => {
    term.refit();
    term.focus();
  }, [dock]);

  // A staged prompt (e.g. from a Generate button) is typed onto the agent's prompt
  // for the user to review and send; nothing runs until they press Enter. Both of
  // these wait for `ready`, so a button pressed while the panel was closed still
  // lands: the prompt sits in the store until the session that will receive it is up.
  useEffect(() => {
    if (draft === null || !ready) return;
    term.type(draft, false);
    clearDraft();
  }, [draft, ready, clearDraft]);

  // A queued prompt (e.g. background Playwright init) is submitted straight away.
  useEffect(() => {
    if (pendingSend === null || !ready) return;
    term.type(pendingSend, true);
    clearPendingSend();
  }, [pendingSend, ready, clearPendingSend]);

  // Native file drop: Tauri gives us real filesystem paths. When files are dropped
  // over this panel, their paths are typed onto the prompt so the user can add an
  // instruction ("import these") and send.
  useEffect(() => {
    const overPanel = (pos?: { x: number; y: number }) => {
      const el = panelRef.current;
      if (!el || !pos) return false;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(overPanel(p.position));
        } else if (p.type === "leave") {
          setDragOver(false);
        } else if (p.type === "drop") {
          setDragOver(false);
          if (overPanel(p.position) && p.paths.length > 0) {
            term.type(`${p.paths.map(quotePath).join(" ")} `, false);
          }
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const active = agents.find((a) => a.id === agentId);
  // Advisory, not a gate: the panel runs a login shell, which can find a CLI that a
  // PATH lookup from the app process missed.
  const missing = !!active && !active.available;

  return (
    <aside
      ref={panelRef}
      style={right ? { width } : { height }}
      className={cn(
        "relative flex shrink-0 flex-col bg-bg-surface",
        right
          ? "max-w-[70%] border-l border-border-subtle"
          : "max-h-[70%] border-t border-border-subtle",
        dragOver && "ring-2 ring-inset ring-brand-accent",
      )}
    >
      <Handle dock={dock} />

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-bg-base/70">
          <div className="rounded-card border border-brand-accent/50 bg-bg-surface px-4 py-2 text-sm text-brand-accent">
            Drop file to add its path
          </div>
        </div>
      )}

      <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <TerminalIcon size={14} className="shrink-0 text-brand-accent" />
        <span className="shrink-0 text-sm font-semibold text-text-primary">
          Assistant
        </span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-muted"
          title={command}
        >
          {command}
        </code>
        {exited && (
          <span className="shrink-0 rounded-control bg-status-blocked/15 px-1.5 py-0.5 text-[10px] text-status-blocked">
            exited
          </span>
        )}

        <div className="relative shrink-0">
          <button
            onClick={() => setPickerOpen((o) => !o)}
            title="Which agent CLI the terminal runs. Changing it starts a fresh session"
            className="flex items-center gap-1 rounded-control border border-border-subtle bg-bg-surface-2 px-2 py-1 text-xs text-text-secondary hover:border-border-strong"
          >
            {active?.name ?? agentId}
            {missing && (
              <TriangleAlert size={11} className="text-status-blocked" />
            )}
            <ChevronDown size={12} className="text-text-muted" />
          </button>
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setAgent(a.id);
                      setPickerOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary"
                  >
                    {a.name}
                    {!a.available && (
                      <span className="text-[10px] text-text-muted">not on PATH</span>
                    )}
                  </button>
                ))}
                <button
                  onClick={() => {
                    refreshAgents();
                    setPickerOpen(false);
                  }}
                  className="mt-1 w-full border-t border-border-subtle px-3 pb-0.5 pt-1.5 text-left text-[11px] text-text-muted hover:text-text-primary"
                >
                  Check again
                </button>
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Icon
            label="Dock to the right"
            active={right}
            onClick={() => setDock("right")}
            Glyph={PanelRight}
          />
          <Icon
            label="Dock to the bottom"
            active={!right}
            onClick={() => setDock("bottom")}
            Glyph={PanelBottom}
          />
          <span className="mx-1 h-4 w-px bg-border-subtle" />
          <Icon
            label="Clear the scrollback. The session keeps running"
            onClick={() => term.clear()}
            Glyph={Eraser}
          />
          <Icon
            label={exited ? "Start a fresh session" : "Kill this shell and start a fresh one"}
            onClick={restart}
            Glyph={RotateCw}
          />
          <Icon
            label="Hide the panel (⌘J). The session keeps running"
            onClick={() => setOpen(false)}
            Glyph={X}
          />
        </div>
      </header>

      {missing && <MissingAgentNotice name={active?.name ?? agentId} />}

      <div
        ref={host}
        onMouseDown={() => term.focus()}
        className="min-h-0 flex-1 overflow-hidden bg-bg-base px-2 py-1.5"
      />
    </aside>
  );
}

/** Advisory strip: the chosen CLI was not found on the app's PATH. The login shell
 *  behind the panel may still find it, so this informs rather than blocks. */
function MissingAgentNotice({ name }: { name: string }) {
  return (
    <div className="flex items-start gap-2 border-b border-border-subtle bg-status-blocked/10 px-3 py-2 text-[11px] text-status-blocked">
      <TriangleAlert size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {name} was not found on PATH. If the shell below cannot start it either,
        install it and restart the session.
      </span>
      <button
        onClick={() =>
          void api.openUrl("https://docs.anthropic.com/en/docs/claude-code/setup")
        }
        className="shrink-0 underline decoration-status-blocked/40 underline-offset-2 hover:decoration-status-blocked"
      >
        Setup docs
      </button>
    </div>
  );
}

function Icon({
  label,
  onClick,
  Glyph,
  active,
}: {
  label: string;
  onClick: () => void;
  Glyph: typeof PanelRight;
  active?: boolean;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "rounded-control p-1.5 transition-colors hover:bg-bg-surface-2",
        active ? "text-brand-accent" : "text-text-muted hover:text-text-primary",
      )}
    >
      <Glyph size={13} />
    </button>
  );
}

/** The draggable edge. Sits on the border the panel shares with the screen. */
function Handle({ dock }: { dock: Dock }) {
  const setSize = useAssistant((s) => s.setSize);

  function start(e: React.MouseEvent) {
    e.preventDefault();
    const right = dock === "right";
    const from = right ? e.clientX : e.clientY;
    const { width, height } = useAssistant.getState();
    const was = right ? width : height;
    // Text selection during a drag turns the whole window blue.
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    function move(ev: MouseEvent) {
      // Dragging towards the screen's centre grows the panel, hence the inverted delta.
      setSize(was + (from - (right ? ev.clientX : ev.clientY)));
    }
    function stop() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.style.userSelect = previous;
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }

  return (
    <div
      onMouseDown={start}
      className={cn(
        "absolute z-10 transition-colors hover:bg-brand-accent/50",
        dock === "right"
          ? "-left-0.5 top-0 h-full w-1 cursor-col-resize"
          : "-top-0.5 left-0 h-1 w-full cursor-row-resize",
      )}
    />
  );
}
