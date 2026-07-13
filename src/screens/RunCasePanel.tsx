import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  FileArchive,
  Loader2,
  PenLine,
  Play,
  X,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { ResultStatus, RunResultRow } from "@/lib/types";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";
import { cn, initials, relativeTime } from "@/lib/utils";
import { AutomationBadge, PriorityBadge } from "@/components/ui/Badge";

/** Row-level result setter, shared with the run table. Untested has no button;
 *  it's the default. */
export const STATUS_KEYS: { status: ResultStatus; label: string; className: string }[] =
  [
    { status: "passed", label: "Pass", className: "text-status-passed" },
    { status: "failed", label: "Fail", className: "text-status-failed" },
    { status: "blocked", label: "Block", className: "text-status-blocked" },
    { status: "retest", label: "Retest", className: "text-status-retest" },
    { status: "skipped", label: "Skip", className: "text-status-skipped" },
  ];

/** Slide-over shown inside a run: the full case content (preconditions, steps,
 *  expected results) next to the result controls, so a tester can read and
 *  record without leaving the run. Prev/next steps through the run's cases. */
export function RunCasePanel({
  row,
  index,
  total,
  pending,
  onClose,
  onNav,
  onSetStatus,
  onSetComment,
}: {
  row: RunResultRow;
  index: number;
  total: number;
  pending: boolean;
  onClose: () => void;
  onNav: (dir: -1 | 1) => void;
  onSetStatus: (status: ResultStatus) => void;
  onSetComment: (comment: string) => void;
}) {
  const openCase = useSession((s) => s.openCase);

  const { data: tc } = useQuery({
    queryKey: ["case", row.case],
    queryFn: () => api.getCase(row.case),
  });

  const [comment, setComment] = useState(row.comment ?? "");
  useEffect(() => setComment(row.comment ?? ""), [row.case, row.comment]);

  const saveComment = () => {
    if ((comment ?? "") !== (row.comment ?? "")) onSetComment(comment);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft") onNav(-1);
      if (e.key === "ArrowRight") onNav(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNav]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex h-full w-[600px] max-w-full flex-col border-l border-border-subtle bg-bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
          <span className="font-mono text-xs text-brand-primary">
            {row.case}
          </span>
          <span className="truncate font-mono text-[11px] text-text-muted">
            {row.suite}
            {row.section ? ` / ${row.section}` : ""}
          </span>
          <div className="flex-1" />
          <span className="font-mono text-[11px] text-text-muted">
            {index + 1} / {total}
          </span>
          <button
            onClick={() => onNav(-1)}
            disabled={index === 0}
            title="Previous case (←)"
            className="text-text-muted hover:text-text-primary disabled:opacity-30"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => onNav(1)}
            disabled={index === total - 1}
            title="Next case (→)"
            className="text-text-muted hover:text-text-primary disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={() => openCase(row.case)}
            title="Open in the case editor"
            className="ml-2 text-text-muted hover:text-text-primary"
          >
            <PenLine size={14} />
          </button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="ml-1 text-text-muted hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        {/* Case content */}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <h2 className="text-lg font-semibold tracking-tight text-text-primary">
            {row.title}
          </h2>
          <div className="mt-1.5 flex items-center gap-2">
            <PriorityBadge priority={row.priority} />
            <AutomationBadge state={row.automationState} />
            {row.source === "automated" && (
              <span className="inline-flex items-center gap-1 rounded bg-bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
                <Play size={9} /> auto
                {row.elapsed ? ` · ${row.elapsed}` : ""}
              </span>
            )}
          </div>

          {!tc ? (
            <div className="mt-8 flex items-center gap-2 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading case…
            </div>
          ) : (
            <>
              {tc.preconditions.length > 0 && (
                <section className="mt-5">
                  <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                    Preconditions
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {tc.preconditions.map((p, i) => (
                      <li
                        key={i}
                        className="selectable text-sm leading-relaxed text-text-secondary"
                      >
                        · {p}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="mt-5">
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  Steps
                </h3>
                {tc.steps.length === 0 ? (
                  <p className="text-sm text-text-muted">
                    No steps parsed for this case.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-card border border-border-subtle">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border-subtle bg-bg-surface-2/50 text-left text-[11px] uppercase tracking-wider text-text-muted">
                          <th className="w-9 py-1.5 pl-3">#</th>
                          <th className="py-1.5">Action</th>
                          <th className="py-1.5 pr-3">Expected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tc.steps.map((s) => (
                          <tr
                            key={s.number}
                            className="border-b border-border-subtle/60 align-top last:border-0"
                          >
                            <td className="py-2 pl-3 font-mono text-xs text-text-muted">
                              {s.number}
                            </td>
                            <td className="selectable py-2 pr-4 leading-relaxed text-text-primary">
                              {s.action}
                            </td>
                            <td className="selectable py-2 pr-3 leading-relaxed text-text-secondary">
                              {s.expected ?? "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {row.evidence.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Evidence
              </h3>
              <div className="flex flex-wrap items-center gap-1.5">
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
                      className="inline-flex max-w-[200px] items-center gap-1 truncate rounded-control bg-bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* Result controls */}
        <div
          className={cn(
            "border-t border-border-subtle px-5 py-4",
            pending && "opacity-60",
          )}
        >
          <div className="flex items-center gap-3">
            <div className="inline-flex overflow-hidden rounded-control border border-border-subtle">
              {STATUS_KEYS.map((s) => (
                <button
                  key={s.status}
                  onClick={() => onSetStatus(s.status)}
                  className={cn(
                    "border-r border-border-subtle px-3 py-1.5 text-xs font-medium transition-colors last:border-r-0",
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
              <span className="text-[11px] text-text-muted">Untested</span>
            )}
            <div className="flex-1" />
            {row.executedBy && (
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
            )}
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onBlur={saveComment}
            placeholder="Add a comment"
            rows={3}
            className="mt-3 w-full resize-none rounded-control border border-border-subtle bg-bg-base px-2.5 py-2 text-sm leading-relaxed text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-text-muted">
            The comment is saved when you click away from the field.
          </p>
        </div>
      </div>
    </div>
  );
}
