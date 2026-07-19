import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  ChevronDown,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, assistantEvents, errMsg } from "@/lib/ipc";
import { track } from "@/lib/telemetry";
import type { AgentAvailability, ChatMessage } from "@/lib/types";
import { useAssistant } from "@/store/assistant";
import { cn } from "@/lib/utils";

/** Quote a path for the composer when it contains whitespace. */
function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** Quick-start prompts shown on an empty conversation. */
const SUGGESTIONS = [
  "Import test cases from a CSV file",
  "Convert a Playwright spec into a manual test case",
  "Suggest new test cases to close coverage gaps",
  "Run exploratory testing on a page and file findings",
];

// Queries whose data the assistant may have changed on disk.
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

function newTurnId(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AssistantPanel() {
  const open = useAssistant((s) => s.open);
  const setOpen = useAssistant((s) => s.setOpen);
  const agentId = useAssistant((s) => s.agentId);
  const setAgent = useAssistant((s) => s.setAgent);
  const sessionId = useAssistant((s) => s.sessionId);
  const messages = useAssistant((s) => s.messages);
  const busy = useAssistant((s) => s.busy);
  const beginTurn = useAssistant((s) => s.beginTurn);
  const appendText = useAssistant((s) => s.appendText);
  const appendActivity = useAssistant((s) => s.appendActivity);
  const finishTurn = useAssistant((s) => s.finishTurn);
  const reset = useAssistant((s) => s.reset);
  const draft = useAssistant((s) => s.draft);
  const clearDraft = useAssistant((s) => s.clearDraft);
  const pendingSend = useAssistant((s) => s.pendingSend);
  const clearPendingSend = useAssistant((s) => s.clearPendingSend);

  const qc = useQueryClient();
  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [input, setInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load installed agents and default to the first available one. Re-run via
  // "Check again" after the user installs a CLI; no app restart needed.
  const refreshAgents = useCallback(() => {
    api.listAgents().then((list) => {
      setAgents(list);
      const firstAvail = list.find((a) => a.available) ?? list[0];
      if (firstAvail) setAgent(firstAvail.id);
    });
  }, [setAgent]);
  useEffect(() => {
    refreshAgents();
  }, [refreshAgents]);

  const noAgents = agents.length > 0 && !agents.some((a) => a.available);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy || noAgents) return;
      const turnId = newTurnId();
      const history: ChatMessage[] = messages
        .filter((m) => !m.streaming && !m.error)
        .map((m) => ({ role: m.role, content: m.content }));
      beginTurn(turnId, trimmed);
      setInput("");
      try {
        await api.assistantSend({
          turnId,
          agentId,
          message: trimmed,
          sessionId,
          history,
        });
      } catch (e) {
        finishTurn(turnId, "", null, errMsg(e));
      }
    },
    [busy, noAgents, messages, beginTurn, agentId, sessionId, finishTurn],
  );

  // Subscribe to streamed assistant events for the lifetime of the panel.
  useEffect(() => {
    const unlisten = [
      assistantEvents.onChunk((e) => {
        if (e.kind === "text") appendText(e.turnId, e.text);
        else appendActivity(e.turnId, e.text);
      }),
      assistantEvents.onFinished((e) => {
        finishTurn(e.turnId, e.reply, e.sessionId, e.error);
        // The agent may have written files; refresh the data-backed views.
        REFRESH_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        // If this turn was a spec generation, link it in code once the spec is
        // on disk. The agent no longer edits the case front matter itself (a
        // malformed hand-edit used to make the case vanish); TestHound records
        // the link atomically instead. If the spec is not there yet (the agent
        // is still iterating), the pending marker stays for a later turn.
        const { pendingGeneration, agentId: generator, clearGeneration } =
          useAssistant.getState();
        if (!e.error && pendingGeneration) {
          api
            .linkGeneratedSpecs(
              pendingGeneration.caseId,
              pendingGeneration.update,
              generator,
            )
            .then((linked) => {
              if (linked) {
                // A generated spec was good enough to accept and link: the
                // differentiator-value signal.
                void track("spec_accepted", { agent: generator });
                clearGeneration();
                REFRESH_KEYS.forEach((k) =>
                  qc.invalidateQueries({ queryKey: [k] }),
                );
              }
            })
            .catch(() => {
              /* spec not linkable yet; keep the pending marker for next turn */
            });
        }
      }),
    ];
    return () => {
      unlisten.forEach((p) => p.then((fn) => fn()));
    };
  }, [appendText, appendActivity, finishTurn, qc]);

  // Keep the transcript scrolled to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // A staged prompt (e.g. from a Generate button) lands in the composer for
  // the user to review and send; nothing runs until they confirm.
  useEffect(() => {
    if (draft === null) return;
    setInput(draft);
    clearDraft();
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [draft, clearDraft]);

  // A queued prompt (e.g. background Playwright init) is sent automatically once
  // an agent is available and no turn is in flight. With no agent installed it
  // falls back to the composer so the user sees the NoAgents banner + the text.
  useEffect(() => {
    if (pendingSend === null || agents.length === 0) return;
    if (noAgents) {
      setInput(pendingSend);
      clearPendingSend();
      return;
    }
    if (busy) return;
    const text = pendingSend;
    clearPendingSend();
    void send(text);
  }, [pendingSend, agents.length, noAgents, busy, send, clearPendingSend]);

  // Grow the composer with its content (the max-height cap adds a scrollbar).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, open]);

  // Native file drop: Tauri gives us real filesystem paths. When files are
  // dropped over this panel, append their paths to the composer so the user can
  // add an instruction ("import these") and send.
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
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(overPanel(p.position));
        } else if (p.type === "leave") {
          setDragOver(false);
        } else if (p.type === "drop") {
          setDragOver(false);
          if (overPanel(p.position) && p.paths.length > 0) {
            setInput((prev) => {
              const prefix = prev.trimEnd() ? `${prev.trimEnd()} ` : "";
              return `${prefix}${p.paths.map(quotePath).join(" ")} `;
            });
            setTimeout(() => textareaRef.current?.focus(), 0);
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

  if (!open) return null;

  const activeAgent = agents.find((a) => a.id === agentId);

  const stop = () => {
    api.assistantStop().catch(() => {});
  };

  return (
    <aside
      ref={panelRef}
      className={cn(
        "relative flex h-full w-[400px] shrink-0 flex-col border-l border-border-subtle bg-bg-surface",
        dragOver && "ring-2 ring-inset ring-brand-accent",
      )}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-bg-base/70">
          <div className="rounded-card border border-brand-accent/50 bg-bg-surface px-4 py-2 text-sm text-brand-accent">
            Drop file to add its path
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Sparkles size={15} className="text-brand-accent" />
        <span className="text-sm font-semibold text-text-primary">Assistant</span>

        <div className="relative ml-auto">
          <button
            onClick={() => setPickerOpen((o) => !o)}
            className="flex items-center gap-1 rounded-control border border-border-subtle bg-bg-surface-2 px-2 py-1 text-xs text-text-secondary hover:border-border-strong"
          >
            {activeAgent?.name ?? agentId}
            <ChevronDown size={12} className="text-text-muted" />
          </button>
          {pickerOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setPickerOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    disabled={!a.available}
                    onClick={() => {
                      setAgent(a.id);
                      setPickerOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary disabled:opacity-40"
                  >
                    {a.name}
                    {!a.available && (
                      <span className="text-[10px] text-text-muted">
                        not found
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          onClick={reset}
          title="New conversation"
          disabled={busy}
          className="rounded-control p-1 text-text-muted hover:bg-bg-surface-2 hover:text-text-primary disabled:opacity-40"
        >
          <Plus size={15} />
        </button>
        <button
          onClick={() => setOpen(false)}
          title="Close"
          className="rounded-control p-1 text-text-muted hover:bg-bg-surface-2 hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {noAgents && <NoAgentsBanner onRefresh={refreshAgents} />}
        {messages.length === 0 ? (
          noAgents ? null : (
            <div className="flex h-full flex-col justify-center gap-3">
              <p className="text-sm text-text-secondary">
                Ask me to work on your test data. I edit files directly; review
                changes in the Changes panel before committing.
              </p>
              <div className="flex flex-col gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-card border border-border-subtle bg-bg-base px-3 py-2 text-left text-xs text-text-secondary hover:border-border-strong hover:text-text-primary"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <Message key={m.id} msg={m} />
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border-subtle p-2.5">
        <div className="flex items-end gap-2 rounded-card border border-border-subtle bg-bg-base px-2.5 py-2 focus-within:border-border-strong">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={
              noAgents
                ? "Install an agent CLI to use the assistant"
                : busy
                  ? "Working…"
                  : "Ask anything, or drop a file to add its path…"
            }
            disabled={busy || noAgents}
            className="max-h-40 min-h-[20px] flex-1 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-60"
          />
          {busy ? (
            <button
              onClick={stop}
              title="Stop the agent"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-status-failed/90 text-bg-base transition-colors hover:bg-status-failed"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={!input.trim() || noAgents}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-brand-primary text-bg-base transition-colors hover:bg-brand-primary/90 disabled:opacity-40"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Shown when no supported agent CLI is on PATH: how to install one, plus a
 *  re-detect button so no app restart is needed after installing. */
function NoAgentsBanner({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="mb-3 rounded-card border border-status-blocked/30 bg-status-blocked/10 p-3">
      <div className="flex items-start gap-2 text-xs text-status-blocked">
        <TriangleAlert size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">No coding agent found</p>
          <p className="mt-1">
            The assistant drives Claude Code or Codex. Install one, then check
            again:
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <code className="selectable rounded-control bg-bg-base px-2 py-1 font-mono text-[11px] text-text-secondary">
          npm install -g @anthropic-ai/claude-code
        </code>
        <code className="selectable rounded-control bg-bg-base px-2 py-1 font-mono text-[11px] text-text-secondary">
          npm install -g @openai/codex
        </code>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-control border border-border-strong bg-bg-surface-2 px-2 py-1 text-xs text-text-primary hover:bg-bg-surface-2/70"
        >
          <RefreshCw size={11} /> Check again
        </button>
        <button
          onClick={() => void api.openUrl("https://docs.anthropic.com/en/docs/claude-code/setup")}
          className="text-xs text-brand-primary underline decoration-brand-primary/40 underline-offset-2 hover:decoration-brand-primary"
        >
          Claude Code setup docs
        </button>
      </div>
    </div>
  );
}

function Message({ msg }: { msg: import("@/store/assistant").AssistantMsg }) {
  if (msg.role === "user") {
    return (
      <div className="selectable ml-6 self-end whitespace-pre-wrap rounded-card bg-bg-surface-2 px-3 py-2 text-sm text-text-primary">
        {msg.content}
      </div>
    );
  }
  return (
    <div className="mr-2 flex flex-col gap-1.5">
      {msg.activity.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-card border border-border-subtle bg-bg-base px-2.5 py-1.5">
          {msg.activity.slice(-8).map((line, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 font-mono text-[11px] text-text-muted"
            >
              <Wrench size={10} className="shrink-0 text-brand-accent" />
              <span className="selectable truncate">{line}</span>
            </div>
          ))}
        </div>
      )}
      {(msg.content || msg.streaming) && (
        <div
          className={cn(
            "selectable whitespace-pre-wrap text-sm leading-relaxed",
            msg.error ? "text-status-failed" : "text-text-secondary",
          )}
        >
          <Linkified text={msg.content || (msg.streaming ? "Thinking…" : "")} />
          {msg.streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-brand-accent align-middle" />
          )}
        </div>
      )}
    </div>
  );
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Render plain assistant text with http(s) URLs as links that open in the
 *  system browser (the webview itself must never navigate away). */
function Linkified({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // Trailing punctuation belongs to the sentence, not the URL.
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <a
        key={`${m.index}-${url}`}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          void api.openUrl(url);
        }}
        className="text-brand-primary underline decoration-brand-primary/40 underline-offset-2 hover:decoration-brand-primary"
      >
        {url}
      </a>,
    );
    last = m.index + url.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}
