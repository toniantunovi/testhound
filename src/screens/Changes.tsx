import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Sparkles, GitCommitHorizontal } from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { ChangedFile } from "@/lib/types";
import {
  CATEGORY_LABEL,
  groupChanges,
  suggestCommitMessage,
} from "@/lib/changes";
import { diffStat, lineDiff } from "@/lib/diff";
import { DiffView } from "@/components/ui/DiffView";
import { Button } from "@/components/ui/Button";
import { useActivity } from "@/store/activity";
import { usePrefs } from "@/store/prefs";
import { cn } from "@/lib/utils";

/** Frame 13 - Changes / Commit. The Git staging surface: changed TestHound
 *  files grouped semantically, a per-file diff, a drafted commit message, and
 *  commit / commit-and-push controls. */
export function Changes() {
  const qc = useQueryClient();
  const push = useActivity((s) => s.push);
  const finish = useActivity((s) => s.finish);
  const autoSync = usePrefs((s) => s.autoSync);

  const { data: git } = useQuery({
    queryKey: ["git-status"],
    queryFn: api.gitStatus,
    refetchInterval: 5000,
  });
  const changed = useMemo(() => git?.changed ?? [], [git]);

  // Per-file diffs power both the +/- counts in the list and the right pane.
  const diffs = useQueries({
    queries: changed.map((f) => ({
      queryKey: ["file-diff", f.path],
      queryFn: () => api.fileDiff(f.path),
    })),
  });
  const diffByPath = useMemo(() => {
    const m = new Map<
      string,
      { added: number; removed: number; old: string | null; next: string }
    >();
    changed.forEach((f, i) => {
      const d = diffs[i]?.data;
      if (!d) return;
      const stat = diffStat(lineDiff(d.old, d.newContent));
      m.set(f.path, {
        added: stat.added,
        removed: stat.removed,
        old: d.old,
        next: d.newContent,
      });
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, diffs.map((d) => d.dataUpdatedAt).join(",")]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [touchedMessage, setTouchedMessage] = useState(false);

  // Default: everything staged, first file open, message drafted.
  useEffect(() => {
    setSelected(new Set(changed.map((f) => f.path)));
    setActive((a) => a ?? changed[0]?.path ?? null);
    if (!touchedMessage) setMessage(suggestCommitMessage(changed));
  }, [changed, touchedMessage]);

  const commit = useMutation({
    mutationFn: async ({ alsoPush }: { alsoPush: boolean }) => {
      const files = [...selected];
      await api.commitChanges(message, files);
      push(`$ git commit -m "${message.split("\n")[0]}" (${files.length} files)`);
      if (alsoPush) {
        const out = await api.pushChanges();
        push(out || "pushed");
      }
    },
    onSuccess: (_d, { alsoPush }) => {
      finish(alsoPush ? "Committed and pushed" : "Committed");
      setTouchedMessage(false);
      setMessage("");
      qc.invalidateQueries();
    },
    onError: (e) => {
      push(`error: ${errMsg(e)}`);
      finish(null);
    },
  });

  const groups = useMemo(() => groupChanges(changed), [changed]);
  const activeDiff = active ? diffByPath.get(active) : undefined;
  const stagedCount = selected.size;

  const toggle = (path: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  if (changed.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <GitCommitHorizontal size={28} className="text-text-muted" />
        <p className="text-sm text-text-secondary">No uncommitted changes</p>
        <p className="text-xs text-text-muted">
          {autoSync
            ? "Automatic sync is on: edits are committed and shared for you. Recent edits briefly appear here in case you want to review them."
            : "Edits to cases, specs, and results will appear here to review and commit."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Changes list */}
      <div className="flex w-[420px] shrink-0 flex-col border-r border-border-subtle">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            Changes
            <span className="rounded-control bg-bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
              {changed.length}
            </span>
          </h1>
          <button
            onClick={() => setSelected(new Set(changed.map((f) => f.path)))}
            className="text-xs text-brand-primary hover:underline"
          >
            Stage all
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-2">
          {groups.map((g) => (
            <div key={g.category} className="mb-1">
              <div className="px-4 py-1.5 text-[11px] text-text-muted">
                {CATEGORY_LABEL[g.category]} · {g.files.length}
              </div>
              {g.files.map((f) => (
                <ChangeRow
                  key={f.path}
                  file={f}
                  active={active === f.path}
                  staged={selected.has(f.path)}
                  stat={diffByPath.get(f.path)}
                  onOpen={() => setActive(f.path)}
                  onToggle={() => toggle(f.path)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Diff + commit */}
      <div className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-3">
              <span className="truncate font-mono text-sm text-text-primary">
                {basename(active)}
              </span>
              <div className="flex-1" />
              {activeDiff && (
                <>
                  <span className="font-mono text-xs text-status-passed">
                    +{activeDiff.added}
                  </span>
                  <span className="font-mono text-xs text-status-failed">
                    -{activeDiff.removed}
                  </span>
                </>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-4">
              {activeDiff ? (
                <DiffView
                  old={activeDiff.old}
                  next={activeDiff.next}
                  showLineNumbers={false}
                  header={false}
                  fill
                  className="h-full"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-text-muted">
                  Loading diff…
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            Select a file to view its diff.
          </div>
        )}

        {/* Commit box */}
        <div className="border-t border-border-subtle p-4">
          {autoSync && (
            <p className="mb-3 rounded-control border border-brand-accent/25 bg-brand-accent/5 px-3 py-2 text-xs text-text-secondary">
              Automatic sync is on: TestHound commits and syncs its own files
              (cases, runs, linked specs) for you after a short pause, paused
              while you review here. Other project files are never
              auto-committed; commit them manually below.
            </p>
          )}
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Commit message</span>
            <button
              onClick={() => {
                setMessage(suggestCommitMessage(changed));
                setTouchedMessage(true);
              }}
              className="flex items-center gap-1.5 rounded-control border border-border-subtle bg-bg-surface-2 px-2 py-1 text-xs text-brand-accent hover:border-border-strong"
            >
              <Sparkles size={12} /> Suggest
            </button>
          </div>
          <textarea
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setTouchedMessage(true);
            }}
            spellCheck={false}
            rows={3}
            placeholder="Describe the change…"
            className="selectable w-full resize-none rounded-card border border-border-subtle bg-bg-base p-3 font-mono text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
          />
          {commit.isError && (
            <p className="mt-2 whitespace-pre-wrap rounded-control border border-status-failed/30 bg-status-failed/10 px-3 py-2 text-xs text-status-failed">
              {errMsg(commit.error)}
            </p>
          )}
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs text-text-muted">
              {stagedCount} of {changed.length} files staged
            </span>
            <div className="flex-1" />
            <Button
              variant="secondary"
              size="md"
              disabled={stagedCount === 0 || !message.trim() || commit.isPending}
              onClick={() => commit.mutate({ alsoPush: false })}
            >
              Commit
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={stagedCount === 0 || !message.trim() || commit.isPending}
              onClick={() => commit.mutate({ alsoPush: true })}
            >
              Commit &amp; push
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const statusMeta: Record<string, { label: string; className: string }> = {
  M: { label: "M", className: "bg-status-drifted/15 text-status-drifted" },
  A: { label: "A", className: "bg-status-passed/15 text-status-passed" },
  "??": { label: "A", className: "bg-status-passed/15 text-status-passed" },
  D: { label: "D", className: "bg-status-failed/15 text-status-failed" },
  R: { label: "R", className: "bg-brand-primary/15 text-brand-primary" },
};

function ChangeRow({
  file,
  active,
  staged,
  stat,
  onOpen,
  onToggle,
}: {
  file: ChangedFile;
  active: boolean;
  staged: boolean;
  stat?: { added: number; removed: number };
  onOpen: () => void;
  onToggle: () => void;
}) {
  const meta = statusMeta[file.status] ?? statusMeta.M;
  return (
    <div
      onClick={onOpen}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-3 py-1.5",
        active ? "bg-bg-surface-2" : "hover:bg-bg-surface-2/50",
      )}
    >
      <input
        type="checkbox"
        checked={staged}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
        className="accent-brand-primary"
      />
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold",
          meta.className,
        )}
      >
        {meta.label}
      </span>
      <span
        title={file.path}
        className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary"
      >
        {shortenPath(file.path)}
      </span>
      {stat && (
        <span className="flex shrink-0 gap-1.5 font-mono text-[11px]">
          <span className="text-status-passed">+{stat.added}</span>
          <span className="text-status-failed">-{stat.removed}</span>
        </span>
      )}
    </div>
  );
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Case files sit deep under `suites/<suite>/cases/`; collapse that prefix to
 *  `…/cases/` so the id stays readable. Other paths truncate at the right. */
function shortenPath(path: string): string {
  const i = path.lastIndexOf("/cases/");
  return i >= 0 ? `…${path.slice(i)}` : path;
}
