import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, History, RotateCcw, Sparkles } from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { useSession } from "@/store/session";
import { useAssistant } from "@/store/assistant";
import { useActivity } from "@/store/activity";
import { DiffView } from "@/components/ui/DiffView";
import { Button } from "@/components/ui/Button";
import { cn, initials, relativeTime } from "@/lib/utils";

/** Frame 05 - Test Case History & Diff. A timeline of the commits that touched a
 *  case with a field/step-level diff viewer, blame, and restore. */
export function CaseHistory() {
  const id = useSession((s) => s.openCaseId);
  const openCase = useSession((s) => s.openCase);
  const startGeneration = useAssistant((s) => s.startGeneration);
  const push = useActivity((s) => s.push);
  const qc = useQueryClient();

  const { data: commits = [], isLoading } = useQuery({
    queryKey: ["case-history", id],
    queryFn: () => api.caseHistory(id!),
    enabled: !!id,
  });

  const [selected, setSelected] = useState<string | null>(null);
  const [blame, setBlame] = useState(false);
  useEffect(() => {
    setSelected((s) => s ?? commits[0]?.hash ?? null);
  }, [commits]);

  const { data: diff } = useQuery({
    queryKey: ["case-commit-diff", id, selected],
    queryFn: () => api.caseCommitDiff(id!, selected!),
    enabled: !!id && !!selected,
  });

  const { data: blameLines } = useQuery({
    queryKey: ["case-blame", id],
    queryFn: () => api.caseBlame(id!),
    enabled: !!id && blame,
  });
  const { data: working } = useQuery({
    queryKey: ["file-diff", diff?.path],
    queryFn: () => api.fileDiff(diff!.path),
    enabled: blame && !!diff?.path,
  });

  const restore = useMutation({
    mutationFn: () => api.restoreCaseVersion(id!, selected!),
    onSuccess: () => {
      push(`restored ${id} to ${selected?.slice(0, 7)}`);
      qc.invalidateQueries({ queryKey: ["case", id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      openCase(id!);
    },
    onError: (e) => push(`error: ${errMsg(e)}`),
  });

  return (
    <div className="flex h-full min-h-0">
      {/* Commit timeline */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border-subtle xl:w-[360px]">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <button
            onClick={() => id && openCase(id)}
            className="text-text-muted hover:text-text-primary"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
            Commit history · <span className="font-mono normal-case">{id}</span>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {isLoading ? (
            <p className="px-1 text-sm text-text-muted">Loading history…</p>
          ) : commits.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 pt-12 text-center">
              <History size={22} className="text-text-muted" />
              <p className="text-sm text-text-secondary">No commits yet</p>
              <p className="text-xs text-text-muted">
                This case has not been committed to Git.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {commits.map((c) => (
                <button
                  key={c.hash}
                  onClick={() => setSelected(c.hash)}
                  className={cn(
                    "rounded-card border px-3 py-2.5 text-left transition-colors",
                    selected === c.hash
                      ? "border-brand-primary/60 bg-brand-primary/5"
                      : "border-transparent hover:bg-bg-surface-2/50",
                  )}
                >
                  <div className="text-sm leading-snug text-text-primary">
                    {c.summary || "(no message)"}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-xs">
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-bg-surface-2 font-mono text-[9px] text-text-secondary">
                      {initials(c.author)}
                    </span>
                    <span className="text-text-secondary">{c.author}</span>
                    <div className="flex-1" />
                    <span className="font-mono text-brand-primary">{c.short}</span>
                    <span className="text-text-muted">{relativeTime(c.when)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Diff pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {diff ? (
          <>
            <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-3">
              <div className="min-w-0">
                <h1 className="text-md font-semibold">
                  Diff · <span className="font-mono">commit {diff.commit.short}</span>
                </h1>
                <p className="mt-0.5 truncate font-mono text-xs text-text-muted">
                  {diff.commit.author} committed {relativeTime(diff.commit.when)} ·{" "}
                  {diff.path.split("/").pop()}
                </p>
              </div>
              <div className="flex-1" />
              <Button
                variant={blame ? "primary" : "secondary"}
                size="sm"
                onClick={() => setBlame((b) => !b)}
              >
                Blame
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={restore.isPending}
                onClick={() => restore.mutate()}
              >
                <RotateCcw size={13} /> Restore this version
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden p-4">
              {blame ? (
                <BlamePane
                  lines={(working?.newContent ?? "").replace(/\n$/, "").split("\n")}
                  blame={blameLines ?? []}
                />
              ) : (
                <DiffView
                  old={diff.old}
                  next={diff.newContent}
                  title={diff.path}
                  fill
                  className="h-full"
                />
              )}
            </div>

            {diff.affectsSpec && (
              <div className="mx-4 mb-4 flex items-center gap-3 rounded-card border border-status-drifted/30 bg-status-drifted/10 px-4 py-3">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-drifted" />
                <span className="flex-1 text-sm text-text-secondary">
                  This commit changed step expectations. The linked Playwright
                  spec is now marked drifted.
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  className="bg-brand-accent hover:bg-brand-accent/90"
                  onClick={() =>
                    id &&
                    api
                      .generationPrompt(id, true)
                      .then((p) => startGeneration(id, true, p))
                      .catch((e) => window.alert(errMsg(e)))
                  }
                >
                  <Sparkles size={13} /> Update spec
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            {isLoading ? "" : "Select a commit to view its diff."}
          </div>
        )}
      </div>
    </div>
  );
}

/** Current file lines with a per-line commit/author gutter. */
function BlamePane({
  lines,
  blame,
}: {
  lines: string[];
  blame: { line: number; short: string; author: string }[];
}) {
  const byLine = new Map(blame.map((b) => [b.line, b]));
  return (
    <div className="h-full overflow-auto rounded-card border border-border-subtle bg-bg-base font-mono text-[12px] leading-relaxed">
      {lines.map((text, i) => {
        const b = byLine.get(i + 1);
        return (
          <div key={i} className="flex">
            <span className="w-24 shrink-0 select-none truncate border-r border-border-subtle/50 px-2 text-text-muted">
              {b?.short}
            </span>
            <span className="w-20 shrink-0 select-none truncate border-r border-border-subtle/50 px-2 text-text-muted">
              {b?.author}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-border-subtle/50 px-1 text-right text-text-muted">
              {i + 1}
            </span>
            <span className="selectable whitespace-pre-wrap break-all px-3 text-text-secondary">
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
