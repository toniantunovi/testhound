import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Eye,
  FileArchive,
  Loader2,
  Play,
  Stethoscope,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { track } from "@/lib/telemetry";
import type { ResultStatus, RunResultRow, RunState } from "@/lib/types";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";
import { usePlaywrightSetup } from "@/store/playwrightSetup";
import { TriageModal } from "@/screens/TriageModal";
import { RunCasePanel, STATUS_KEYS } from "@/screens/RunCasePanel";
import { cn, initials, relativeTime } from "@/lib/utils";
import {
  AutomationBadge,
  PriorityBadge,
  RunStateBadge,
} from "@/components/ui/Badge";
import { RunProgressBar } from "@/components/ui/RunProgressBar";
import { Button } from "@/components/ui/Button";

export function RunView() {
  const id = useSession((s) => s.openRunId);
  const navigate = useSession((s) => s.navigate);
  const runningRunId = useActivity((s) => s.runningRunId);
  const openPwSetup = usePlaywrightSetup((s) => s.open);
  const pwInitializing = usePlaywrightSetup((s) => s.initializing);
  const qc = useQueryClient();
  const [triage, setTriage] = useState<{ caseId: string; title: string } | null>(
    null,
  );
  const [headed, setHeaded] = useState(false);
  /** Case open in the read-and-record slide-over, if any. */
  const [panelCaseId, setPanelCaseId] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: !!id,
  });

  const { data: pw } = useQuery({
    queryKey: ["playwright-info"],
    queryFn: api.playwrightInfo,
  });

  const runAutomated = useMutation({
    mutationFn: () => api.runPlaywright(id!, headed),
    onError: (e) => useActivity.getState().push(`x ${errMsg(e)}`),
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
    onSuccess: () => {
      void track("result_recorded", { source: "manual" });
      invalidate();
    },
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
  const running = runningRunId === run.id;
  const automatable = rows.filter(
    (r) => r.automationState === "linked" || r.automationState === "drifted",
  ).length;
  const panelIdx = panelCaseId
    ? rows.findIndex((r) => r.case === panelCaseId)
    : -1;
  const panelRow = panelIdx >= 0 ? rows[panelIdx] : null;

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
        {pw?.detected ? (
          <>
            <button
              onClick={() => setHeaded((h) => !h)}
              disabled={running}
              title="Run in a visible browser you can watch (headed, one test at a time)"
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-xs font-medium transition-colors disabled:opacity-50",
                headed
                  ? "border-brand-accent/40 bg-brand-accent/10 text-brand-accent"
                  : "border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary",
              )}
            >
              <Eye size={13} /> Visible browser
            </button>
            <Button
              size="sm"
              variant="secondary"
              disabled={running || automatable === 0}
              title={
                automatable === 0
                  ? "No cases in this run have a linked spec"
                  : "Execute linked Playwright specs and ingest results"
              }
              onClick={() => runAutomated.mutate()}
            >
            {running ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Running…
              </>
            ) : (
              <>
                <Play size={13} /> Run automated
              </>
            )}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={pwInitializing}
            title={
              pwInitializing
                ? "The assistant is setting Playwright up; this enables once it finishes"
                : "Playwright is not set up in this repo. Click to initialize it, then run."
            }
            onClick={openPwSetup}
          >
            {pwInitializing ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Initializing
                Playwright…
              </>
            ) : (
              <>
                <Play size={13} /> Run automated
              </>
            )}
          </Button>
        )}
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
                onTriage={() =>
                  setTriage({ caseId: row.case, title: row.title })
                }
                onOpen={() => setPanelCaseId(row.case)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {triage && (
        <TriageModal
          runId={run.id}
          caseId={triage.caseId}
          caseTitle={triage.title}
          onClose={() => setTriage(null)}
        />
      )}

      {panelRow && (
        <RunCasePanel
          row={panelRow}
          index={panelIdx}
          total={rows.length}
          pending={
            setResult.isPending && setResult.variables?.caseId === panelRow.case
          }
          onClose={() => setPanelCaseId(null)}
          onNav={(dir) => {
            const next = rows[panelIdx + dir];
            if (next) setPanelCaseId(next.case);
          }}
          onSetStatus={(status) =>
            setResult.mutate({ caseId: panelRow.case, status, comment: null })
          }
          onSetComment={(comment) =>
            setResult.mutate({
              caseId: panelRow.case,
              status:
                panelRow.status === "untested" ? "retest" : panelRow.status,
              comment,
            })
          }
        />
      )}
    </div>
  );
}

function CaseRow({
  row,
  pending,
  onSetStatus,
  onSetComment,
  onTriage,
  onOpen,
}: {
  row: RunResultRow;
  pending: boolean;
  onSetStatus: (status: ResultStatus) => void;
  onSetComment: (comment: string) => void;
  onTriage: () => void;
  onOpen: () => void;
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
        <button
          onClick={onOpen}
          title="Open case"
          className="hover:underline decoration-dotted underline-offset-2"
        >
          {row.case}
        </button>
      </td>
      <td className="py-3 pr-4">
        <button
          onClick={onOpen}
          title="Open case"
          className="text-left text-text-primary hover:text-brand-primary"
        >
          {row.title}
        </button>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[11px] text-text-muted">
            {row.suite}
            {row.section ? ` / ${row.section}` : ""}
          </span>
          <AutomationBadge state={row.automationState} />
          {row.source === "automated" && (
            <span className="inline-flex items-center gap-1 rounded bg-bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
              <Play size={9} /> auto
              {row.elapsed ? ` · ${row.elapsed}` : ""}
            </span>
          )}
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
        {row.evidence.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {row.evidence.map((path) => {
              const name = path.split("/").pop() ?? path;
              const isTrace = path.endsWith(".zip");
              return isTrace ? (
                <button
                  key={path}
                  onClick={() =>
                    api
                      .openTrace(path)
                      .catch((e) =>
                        useActivity.getState().push(`x ${errMsg(e)}`),
                      )
                  }
                  title={path}
                  className="inline-flex items-center gap-1 rounded-control border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-secondary hover:border-border-strong hover:text-text-primary"
                >
                  <FileArchive size={11} /> Open trace
                </button>
              ) : (
                <span
                  key={path}
                  title={path}
                  className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-control bg-bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                >
                  {name}
                </span>
              );
            })}
          </div>
        )}
        {row.status === "failed" && (
          <button
            onClick={onTriage}
            title="Ask an agent to classify this failure and suggest a fix"
            className="mt-1.5 inline-flex items-center gap-1 rounded-control border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-secondary hover:border-brand-accent/50 hover:text-brand-accent"
          >
            <Stethoscope size={11} /> Triage with agent
          </button>
        )}
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
