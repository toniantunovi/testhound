import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check } from "lucide-react";
import { api } from "@/lib/ipc";
import type { ResultStatus, RunResultRow, RunState } from "@/lib/types";
import { useSession } from "@/store/session";
import { cn, initials, relativeTime } from "@/lib/utils";
import {
  AutomationBadge,
  PriorityBadge,
  RunStateBadge,
} from "@/components/ui/Badge";
import { RunProgressBar } from "@/components/ui/RunProgressBar";
import { Button } from "@/components/ui/Button";

// Compact per-row status setter. Untested has no button; it's the default.
const STATUS_KEYS: { status: ResultStatus; label: string; className: string }[] =
  [
    { status: "passed", label: "Pass", className: "text-status-passed" },
    { status: "failed", label: "Fail", className: "text-status-failed" },
    { status: "blocked", label: "Block", className: "text-status-blocked" },
    { status: "retest", label: "Retest", className: "text-status-retest" },
    { status: "skipped", label: "Skip", className: "text-status-skipped" },
  ];

export function RunView() {
  const id = useSession((s) => s.openRunId);
  const navigate = useSession((s) => s.navigate);
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: !!id,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["run", id] });
    qc.invalidateQueries({ queryKey: ["runs"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["git-status"] });
  };

  const setResult = useMutation({
    mutationFn: (v: {
      caseId: string;
      status: ResultStatus;
      comment: string | null;
    }) => api.setResult(id!, v.caseId, v.status, v.comment, null),
    onSuccess: invalidate,
  });

  const setState = useMutation({
    mutationFn: (state: RunState) => api.setRunState(id!, state),
    onSuccess: invalidate,
  });

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        Loading run…
      </div>
    );
  }

  const { run, rows, progress } = data;
  const executed = progress.total - progress.untested;
  const passRate =
    executed === 0 ? 0 : Math.round((progress.passed / executed) * 100);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-3">
        <button
          onClick={() => navigate("runs")}
          className="text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="truncate text-base font-semibold">{run.name}</span>
        <RunStateBadge state={run.state} />
        <div className="flex-1" />
        {run.state !== "complete" && (
          <Button size="sm" onClick={() => setState.mutate("complete")}>
            <Check size={13} /> Mark complete
          </Button>
        )}
        {run.state === "complete" && (
          <Button size="sm" onClick={() => setState.mutate("in_progress")}>
            Reopen
          </Button>
        )}
      </div>

      {/* Summary bar */}
      <div className="flex items-center gap-6 border-b border-border-subtle px-6 py-3">
        <div className="flex items-center gap-3">
          {run.configuration.map((c) => (
            <span
              key={c}
              className="rounded bg-bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary"
            >
              {c}
            </span>
          ))}
          {run.milestone && (
            <span className="text-xs text-text-secondary">{run.milestone}</span>
          )}
        </div>
        <div className="flex-1" />
        <div className="flex w-96 items-center gap-3">
          <RunProgressBar progress={progress} className="flex-1" />
          <span className="shrink-0 font-mono text-xs text-text-secondary">
            {progress.passed}/{progress.total}
            <span className="ml-1 text-text-muted">{passRate}%</span>
          </span>
        </div>
      </div>

      {/* Cases */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-bg-base">
            <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-muted">
              <th className="w-24 py-2 pl-6 font-medium">ID</th>
              <th className="py-2 font-medium">Case</th>
              <th className="w-28 py-2 font-medium">Priority</th>
              <th className="w-[280px] py-2 font-medium">Result</th>
              <th className="w-24 py-2 pr-6 font-medium">By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CaseRow
                key={row.case}
                row={row}
                pending={
                  setResult.isPending &&
                  setResult.variables?.caseId === row.case
                }
                onSetStatus={(status) =>
                  setResult.mutate({ caseId: row.case, status, comment: null })
                }
                onSetComment={(comment) =>
                  setResult.mutate({
                    caseId: row.case,
                    status: row.status === "untested" ? "retest" : row.status,
                    comment,
                  })
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CaseRow({
  row,
  pending,
  onSetStatus,
  onSetComment,
}: {
  row: RunResultRow;
  pending: boolean;
  onSetStatus: (status: ResultStatus) => void;
  onSetComment: (comment: string) => void;
}) {
  const [comment, setComment] = useState(row.comment ?? "");
  useEffect(() => setComment(row.comment ?? ""), [row.comment]);

  return (
    <tr
      className={cn(
        "border-b border-border-subtle/60 align-top",
        pending && "opacity-60",
      )}
    >
      <td className="py-3 pl-6 font-mono text-xs text-brand-primary">
        {row.case}
      </td>
      <td className="py-3 pr-4">
        <div className="text-text-primary">{row.title}</div>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[11px] text-text-muted">
            {row.suite}
            {row.section ? ` / ${row.section}` : ""}
          </span>
          <AutomationBadge state={row.automationState} />
        </div>
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onBlur={() => {
            if ((comment ?? "") !== (row.comment ?? "")) onSetComment(comment);
          }}
          placeholder="Add a comment"
          className="mt-2 h-7 w-full max-w-md rounded-control border border-border-subtle bg-bg-base px-2 text-xs text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
        />
      </td>
      <td className="py-3">
        <PriorityBadge priority={row.priority} />
      </td>
      <td className="py-3">
        <div className="inline-flex overflow-hidden rounded-control border border-border-subtle">
          {STATUS_KEYS.map((s) => (
            <button
              key={s.status}
              onClick={() => onSetStatus(s.status)}
              className={cn(
                "border-r border-border-subtle px-2 py-1 text-[11px] font-medium last:border-r-0 transition-colors",
                row.status === s.status
                  ? cn("bg-bg-surface-2", s.className)
                  : "text-text-muted hover:bg-bg-surface-2/60 hover:text-text-secondary",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        {row.status === "untested" && (
          <div className="mt-1 text-[11px] text-text-muted">Untested</div>
        )}
      </td>
      <td className="py-3 pr-6">
        {row.executedBy ? (
          <div className="flex items-center gap-2">
            <span
              title={row.executedBy}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-bg-surface-2 font-mono text-[10px] text-text-secondary"
            >
              {initials(row.executedBy)}
            </span>
            <span className="text-[11px] text-text-muted">
              {relativeTime(row.executedAt)}
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-text-muted">-</span>
        )}
      </td>
    </tr>
  );
}
