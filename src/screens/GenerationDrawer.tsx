import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  Check,
  FileCode,
  Loader2,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { agentEvents, api, errMsg } from "@/lib/ipc";
import { useAgentDrawer } from "@/store/agent";
import { Button } from "@/components/ui/Button";
import { DiffView } from "@/components/ui/DiffView";
import { cn } from "@/lib/utils";

type Phase = "idle" | "running" | "done" | "empty" | "error";

/** Mounts the drawer only while a case is targeted, keyed by case id so the
 *  per-generation state resets cleanly between cases. */
export function GenerationDrawer() {
  const caseId = useAgentDrawer((s) => s.caseId);
  if (!caseId) return null;
  return <DrawerInner />;
}

function DrawerInner() {
  const caseId = useAgentDrawer((s) => s.caseId)!;
  const caseTitle = useAgentDrawer((s) => s.caseTitle);
  const update = useAgentDrawer((s) => s.update);
  const close = useAgentDrawer((s) => s.close);
  const qc = useQueryClient();

  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [changed, setChanged] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [accepting, setAccepting] = useState(false);

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });
  const { data: ctx } = useQuery({
    queryKey: ["automation-context", caseId],
    queryFn: () => api.automationContext(caseId),
  });

  // Default the picker to the first installed agent.
  useEffect(() => {
    if (!agentId && agents.length) {
      setAgentId(agents.find((a) => a.available)?.id ?? agents[0].id);
    }
  }, [agents, agentId]);

  // Subscribe to this case's agent lifecycle for the duration of the drawer.
  useEffect(() => {
    const unsubs: UnlistenFn[] = [];
    let disposed = false;
    const reg = (p: Promise<UnlistenFn>) =>
      p.then((un) => (disposed ? un() : unsubs.push(un)));

    reg(
      agentEvents.onStarted((e) => {
        if (e.id !== caseId) return;
        setPhase("running");
        setLines([]);
        setError(null);
      }),
    );
    reg(
      agentEvents.onLog((e) => {
        if (e.id === caseId) setLines((l) => [...l, e.line]);
      }),
    );
    reg(
      agentEvents.onFinished((e) => {
        if (e.id !== caseId) return;
        if (e.error) {
          setError(e.error);
          setPhase("error");
        } else if (e.changedSpecs.length) {
          setChanged(e.changedSpecs);
          setSelected(e.changedSpecs[0]);
          setPhase("done");
        } else {
          setPhase("empty");
        }
      }),
    );
    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
    };
  }, [caseId]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const start = () => {
    setPhase("running");
    setLines([]);
    setError(null);
    setChanged([]);
    api.generateSpec(caseId, agentId, update).catch((e) => {
      setError(errMsg(e));
      setPhase("error");
    });
  };

  const accept = () => {
    setAccepting(true);
    api
      .acceptGeneration(caseId, changed, agentId)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["cases"] });
        qc.invalidateQueries({ queryKey: ["case", caseId] });
        qc.invalidateQueries({ queryKey: ["coverage"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        qc.invalidateQueries({ queryKey: ["git-status"] });
        close();
      })
      .catch((e) => {
        setError(errMsg(e));
        setAccepting(false);
      });
  };

  const running = phase === "running";
  const noAgents = agents.length > 0 && !agents.some((a) => a.available);
  const verb = update ? "Update spec" : "Generate spec";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => !running && !accepting && close()}
      />
      <aside className="relative flex h-full w-[640px] max-w-full flex-col border-l border-border-subtle bg-bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
          <Sparkles size={15} className="text-brand-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text-primary">
              {verb}
            </div>
            <div className="truncate font-mono text-[11px] text-text-muted">
              {caseId} · {caseTitle}
            </div>
          </div>
          <button
            onClick={() => !running && !accepting && close()}
            disabled={running || accepting}
            className="text-text-muted hover:text-text-primary disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {/* Context + agent picker */}
          <div className="mb-4 rounded-card border border-border-subtle bg-bg-base p-3 text-xs">
            <div className="grid grid-cols-[80px_1fr] gap-y-1.5 text-text-secondary">
              <span className="text-text-muted">Target</span>
              <span className="font-mono text-text-primary">
                {ctx?.targetPath ?? "…"}
              </span>
              <span className="text-text-muted">Config</span>
              <span className="font-mono">
                {ctx?.config ?? "no playwright.config detected"}
              </span>
              {ctx?.baseUrl && (
                <>
                  <span className="text-text-muted">Base URL</span>
                  <span className="font-mono">{ctx.baseUrl}</span>
                </>
              )}
              <span className="text-text-muted">Agent</span>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={running || phase === "done"}
                className="h-7 w-full rounded-control border border-border-subtle bg-bg-surface px-2 text-xs text-text-primary focus:border-border-strong focus:outline-none"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.available ? "" : " (not installed)"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {noAgents && (
            <div className="mb-4 flex items-start gap-2 rounded-card border border-status-blocked/30 bg-status-blocked/10 p-3 text-xs text-status-blocked">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>
                No agent CLI found on PATH. Install{" "}
                <span className="font-mono">claude</span> or{" "}
                <span className="font-mono">codex</span> to generate specs.
              </span>
            </div>
          )}

          {/* Idle: kick off */}
          {phase === "idle" && (
            <div className="text-xs leading-relaxed text-text-secondary">
              TestHound will ask the agent to {update ? "patch" : "write"} a
              Playwright spec from this case's steps, using the repo's fixtures
              and config. Nothing is committed: you review the diff and accept.
            </div>
          )}

          {/* Live log */}
          {(running || lines.length > 0) && phase !== "done" && (
            <div
              ref={logRef}
              className="mt-1 max-h-64 overflow-auto rounded-card border border-border-subtle bg-bg-base p-3 font-mono text-[11px] leading-relaxed text-text-secondary"
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

          {phase === "empty" && (
            <div className="mt-3 rounded-card border border-border-subtle bg-bg-base p-3 text-xs text-text-secondary">
              The agent finished but no spec files changed. Check the log above,
              adjust the case, and try again.
            </div>
          )}

          {/* Review changed specs */}
          {phase === "done" && (
            <div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {changed.map((path) => (
                  <button
                    key={path}
                    onClick={() => setSelected(path)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-control border px-2 py-1 font-mono text-[11px]",
                      selected === path
                        ? "border-brand-primary/40 bg-brand-primary/10 text-brand-primary"
                        : "border-border-subtle text-text-secondary hover:text-text-primary",
                    )}
                  >
                    <FileCode size={11} />
                    {path.split("/").pop()}
                  </button>
                ))}
              </div>
              {selected && <SpecDiff path={selected} />}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
          {phase === "done" ? (
            <>
              <span className="text-[11px] text-text-muted">
                {changed.length} file(s) changed · not yet committed
              </span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={close} disabled={accepting}>
                Discard
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={accept}
                disabled={accepting}
              >
                {accepting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} />
                )}
                Accept & link
              </Button>
            </>
          ) : (
            <>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={close} disabled={running}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={start}
                disabled={running || noAgents || !agentId}
              >
                {running ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> Running…
                  </>
                ) : (
                  <>
                    <Sparkles size={13} /> {verb}
                  </>
                )}
              </Button>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Loads a changed spec's committed-vs-working diff. */
function SpecDiff({ path }: { path: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["file-diff", path],
    queryFn: () => api.fileDiff(path),
  });
  if (isLoading || !data) {
    return (
      <div className="rounded-card border border-border-subtle p-4 text-xs text-text-muted">
        Loading diff…
      </div>
    );
  }
  return <DiffView old={data.old} next={data.newContent} />;
}
