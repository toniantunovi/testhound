import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Loader2, Stethoscope, TriangleAlert, X } from "lucide-react";
import { agentEvents, api, errMsg } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";

type Phase = "idle" | "running" | "done" | "error";

/** Agent-assisted triage of a failed automated result (docs/05 §5.6). Read-only:
 *  the agent classifies the failure and suggests a fix; nothing is written. */
export function TriageModal({
  runId,
  caseId,
  caseTitle,
  onClose,
}: {
  runId: string;
  caseId: string;
  caseTitle: string;
  onClose: () => void;
}) {
  const id = `${runId}:${caseId}`;
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });
  useEffect(() => {
    if (!agentId && agents.length) {
      setAgentId(agents.find((a) => a.available)?.id ?? agents[0].id);
    }
  }, [agents, agentId]);

  useEffect(() => {
    const unsubs: UnlistenFn[] = [];
    let disposed = false;
    const reg = (p: Promise<UnlistenFn>) =>
      p.then((un) => (disposed ? un() : unsubs.push(un)));
    reg(
      agentEvents.onStarted((e) => {
        if (e.id === id) {
          setPhase("running");
          setLines([]);
        }
      }),
    );
    reg(
      agentEvents.onLog((e) => {
        if (e.id === id) setLines((l) => [...l, e.line]);
      }),
    );
    reg(
      agentEvents.onFinished((e) => {
        if (e.id !== id) return;
        if (e.error) {
          setError(e.error);
          setPhase("error");
        } else {
          setOutput(e.output ?? "(no output)");
          setPhase("done");
        }
      }),
    );
    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
    };
  }, [id]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const start = () => {
    setPhase("running");
    setLines([]);
    setError(null);
    setOutput(null);
    api.triageFailure(runId, caseId, agentId).catch((e) => {
      setError(errMsg(e));
      setPhase("error");
    });
  };

  const running = phase === "running";
  const noAgents = agents.length > 0 && !agents.some((a) => a.available);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-8">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => !running && onClose()}
      />
      <div className="relative flex max-h-[80vh] w-[620px] max-w-full flex-col overflow-hidden rounded-card border border-border-subtle bg-bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
          <Stethoscope size={15} className="text-brand-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-primary">
              Triage failure
            </div>
            <div className="truncate font-mono text-[11px] text-text-muted">
              {caseId} · {caseTitle}
            </div>
          </div>
          <button
            onClick={() => !running && onClose()}
            disabled={running}
            className="text-text-muted hover:text-text-primary disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {noAgents && (
            <div className="mb-3 flex items-start gap-2 rounded-card border border-status-blocked/30 bg-status-blocked/10 p-3 text-xs text-status-blocked">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>
                No agent CLI found on PATH. Install{" "}
                <span className="font-mono">claude</span> or{" "}
                <span className="font-mono">codex</span> to triage failures.
              </span>
            </div>
          )}

          {phase === "idle" && (
            <p className="text-xs leading-relaxed text-text-secondary">
              The agent will read the failing test, its error, and the manual
              case, then classify the failure (product bug / test bug /
              environment) and suggest a fix. Nothing is committed.
            </p>
          )}

          {(running || lines.length > 0) && phase !== "done" && (
            <div
              ref={logRef}
              className="mt-1 max-h-52 overflow-auto rounded-card border border-border-subtle bg-bg-base p-3 font-mono text-[11px] leading-relaxed text-text-secondary"
            >
              {lines.length === 0 ? (
                <span className="text-text-muted">Starting agent…</span>
              ) : (
                lines.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    {l}
                  </div>
                ))
              )}
            </div>
          )}

          {phase === "error" && error && (
            <div className="mt-3 rounded-card border border-status-failed/30 bg-status-failed/10 p-3 text-xs text-status-failed">
              {error}
            </div>
          )}

          {phase === "done" && output && (
            <div className="whitespace-pre-wrap rounded-card border border-border-subtle bg-bg-base p-3 text-xs leading-relaxed text-text-primary">
              {output}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={running}
            className="h-7 rounded-control border border-border-subtle bg-bg-base px-2 text-xs text-text-primary focus:border-border-strong focus:outline-none"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.available ? "" : " (not installed)"}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={start}
            disabled={running || noAgents || !agentId}
          >
            {running ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Analyzing…
              </>
            ) : (
              <>
                <Stethoscope size={13} /> {phase === "done" ? "Re-run" : "Triage"}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
