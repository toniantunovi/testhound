import { useQuery } from "@tanstack/react-query";
import { Play, Plus } from "lucide-react";
import { api } from "@/lib/ipc";
import type { RunSummary } from "@/lib/types";
import { useSession } from "@/store/session";
import { initials, relativeTime } from "@/lib/utils";
import { RunStateBadge } from "@/components/ui/Badge";
import { RunProgressBar } from "@/components/ui/RunProgressBar";
import { Button } from "@/components/ui/Button";

export function Runs() {
  const openRun = useSession((s) => s.openRun);
  const newRun = useSession((s) => s.newRun);
  const { data: runs = [] } = useQuery({
    queryKey: ["runs"],
    queryFn: api.listRuns,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Runs</h1>
          <p className="mt-0.5 text-xs text-text-muted">
            {runs.length} {runs.length === 1 ? "run" : "runs"} · manual and
            automated results
          </p>
        </div>
        <Button variant="primary" size="md" onClick={newRun}>
          <Plus size={14} /> New run
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {runs.length === 0 ? (
          <EmptyState onNew={newRun} />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-bg-base">
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-muted">
                <th className="py-2 pl-6 font-medium">Run</th>
                <th className="w-32 py-2 font-medium">Milestone</th>
                <th className="w-32 py-2 font-medium">State</th>
                <th className="w-64 py-2 font-medium">Progress</th>
                <th className="w-16 py-2 font-medium">Owner</th>
                <th className="w-20 py-2 pr-6 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <RunRow key={r.id} run={r} onOpen={() => openRun(r.id)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  const { progress } = run;
  const executed =
    progress.total - progress.untested === 0
      ? 0
      : Math.round(
          (progress.passed / (progress.total - progress.untested)) * 100,
        );
  return (
    <tr
      onClick={onOpen}
      className="group cursor-pointer border-b border-border-subtle/60 hover:bg-bg-surface/60"
    >
      <td className="py-3 pl-6">
        <div className="text-text-primary">{run.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-text-muted">
          {run.configuration.length > 0 ? (
            run.configuration.map((c) => (
              <span
                key={c}
                className="rounded bg-bg-surface-2 px-1.5 py-0.5 text-text-secondary"
              >
                {c}
              </span>
            ))
          ) : (
            <span>no config</span>
          )}
        </div>
      </td>
      <td className="py-3 text-xs text-text-secondary">
        {run.milestone ?? <span className="text-text-muted">-</span>}
      </td>
      <td className="py-3">
        <RunStateBadge state={run.state} />
      </td>
      <td className="py-3 pr-6">
        <div className="flex items-center gap-3">
          <RunProgressBar progress={progress} className="flex-1" />
          <span className="w-24 shrink-0 text-right font-mono text-xs text-text-secondary">
            {progress.passed}/{progress.total}
            <span className="ml-1 text-text-muted">{executed}%</span>
          </span>
        </div>
      </td>
      <td className="py-3">
        <span
          title={run.assignee ?? undefined}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-bg-surface-2 font-mono text-[10px] text-text-secondary"
        >
          {initials(run.assignee)}
        </span>
      </td>
      <td className="py-3 pr-6 text-xs text-text-muted">
        {relativeTime(run.created)}
      </td>
    </tr>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-card border border-border-subtle bg-bg-surface">
          <Play size={20} className="text-brand-primary" />
        </div>
        <h2 className="mb-1.5 text-base font-medium text-text-primary">
          No runs yet
        </h2>
        <p className="mb-4 text-sm leading-relaxed text-text-secondary">
          Build a run from a suite, a filter query, or a hand-picked set of
          cases, then record results as you execute.
        </p>
        <Button variant="primary" size="md" onClick={onNew} className="mx-auto">
          <Plus size={14} /> New run
        </Button>
      </div>
    </div>
  );
}
