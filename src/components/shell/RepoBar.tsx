import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  GitBranch,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { useSync } from "@/lib/useSync";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";
import { useAssistant } from "@/store/assistant";
import { cn } from "@/lib/utils";

export function RepoBar() {
  const project = useSession((s) => s.project);
  const navigate = useSession((s) => s.navigate);
  const togglePalette = useSession((s) => s.togglePalette);
  const toggleAssistant = useAssistant((s) => s.toggle);
  const assistantOpen = useAssistant((s) => s.open);
  const push = useActivity((s) => s.push);
  const finish = useActivity((s) => s.finish);
  const setActivity = useSession((s) => s.setActivity);
  const qc = useQueryClient();
  const [branchOpen, setBranchOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");

  // Git failures land in the activity console; pop it open so they are seen.
  const surfaceError = (e: unknown) => {
    push(`error: ${errMsg(e)}`);
    finish(null);
    setActivity(true);
  };

  // A branch change (switch or create) touches everything derived from the
  // working tree; refetch those queries instead of invalidating all at once.
  const afterBranchChange = () => {
    setBranchOpen(false);
    setNewBranch("");
    ["git-status", "branches", "conflicts", "cases", "runs", "dashboard", "coverage"].forEach(
      (key) => qc.invalidateQueries({ queryKey: [key] }),
    );
  };

  const { data: git } = useQuery({
    queryKey: ["git-status"],
    queryFn: api.gitStatus,
    refetchInterval: 15000,
    enabled: !!project,
  });
  const { data: branches = [] } = useQuery({
    queryKey: ["branches"],
    queryFn: api.listBranches,
    enabled: !!project && branchOpen,
  });
  const { data: conflicts } = useQuery({
    queryKey: ["conflicts"],
    queryFn: api.listConflicts,
    refetchInterval: 15000,
    enabled: !!project,
  });
  const conflictCount =
    (conflicts?.cases.length ?? 0) + (conflicts?.other.length ?? 0);
  const changeCount = git?.changed.length ?? 0;

  const switchBranch = useMutation({
    mutationFn: (name: string) => api.switchBranch(name),
    onSuccess: afterBranchChange,
    onError: surfaceError,
  });

  const createBranch = useMutation({
    mutationFn: (name: string) => api.createBranch(name),
    onSuccess: afterBranchChange,
  });

  const syncFlow = useSync();

  return (
    <header
      data-tauri-drag-region
      className="th-drag flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle bg-bg-surface px-3 pl-20"
    >
      {/* Brand */}
      <div data-tauri-drag-region className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-brand-primary shadow-[0_0_8px_rgba(110,139,255,0.7)]" />
        <span className="text-sm font-semibold tracking-tight">TestHound</span>
      </div>

      {/* Project switcher */}
      <button className="th-no-drag flex items-center gap-1 rounded-control px-2 py-1 text-sm text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary">
        {project?.name ?? "No project"}
        <ChevronDown size={13} className="text-text-muted" />
      </button>

      {/* Branch selector */}
      <div className="relative th-no-drag">
        <button
          onClick={() => setBranchOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-control border border-border-subtle bg-bg-surface-2 px-2 py-1 text-xs hover:border-border-strong"
        >
          <GitBranch size={12} className="text-brand-accent" />
          <span className="font-mono text-text-primary">
            {git?.branch ?? project?.branch ?? "-"}
          </span>
          <ChevronDown size={12} className="text-text-muted" />
        </button>
        {branchOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setBranchOpen(false)}
            />
            <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-56 overflow-auto rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
              <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Switch branch
              </div>
              {branches.length === 0 && (
                <div className="px-3 py-2 text-xs text-text-muted">Loading…</div>
              )}
              {branches.map((b) => (
                <button
                  key={b}
                  onClick={() => switchBranch.mutate(b)}
                  disabled={switchBranch.isPending}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary"
                >
                  <span className="w-3">
                    {b === git?.branch && (
                      <Check size={12} className="text-brand-primary" />
                    )}
                  </span>
                  {b}
                </button>
              ))}
              <div className="mt-1 border-t border-border-subtle px-3 pb-1.5 pt-2">
                <div className="flex items-center gap-1.5">
                  <input
                    value={newBranch}
                    onChange={(e) => {
                      setNewBranch(e.target.value);
                      createBranch.reset();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newBranch.trim()) {
                        createBranch.mutate(newBranch.trim());
                      }
                    }}
                    placeholder="New branch name…"
                    spellCheck={false}
                    className="selectable min-w-0 flex-1 rounded-control border border-border-subtle bg-bg-base px-2 py-1 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
                  />
                  <button
                    onClick={() => createBranch.mutate(newBranch.trim())}
                    disabled={!newBranch.trim() || createBranch.isPending}
                    title="Create branch from current HEAD and switch to it"
                    className="flex shrink-0 items-center gap-1 rounded-control border border-border-subtle bg-bg-surface-2 px-2 py-1 text-xs text-text-secondary hover:border-border-strong hover:text-text-primary disabled:opacity-50"
                  >
                    {createBranch.isPending ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Plus size={12} />
                    )}
                    Create
                  </button>
                </div>
                {createBranch.isError && (
                  <p className="mt-1.5 whitespace-pre-wrap text-[11px] text-status-failed">
                    {errMsg(createBranch.error)}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Ahead / behind */}
      {git && (git.ahead > 0 || git.behind > 0) && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="flex items-center gap-0.5">
            <ArrowUp size={11} />
            {git.ahead}
          </span>
          <span className="flex items-center gap-0.5">
            <ArrowDown size={11} />
            {git.behind}
          </span>
        </div>
      )}

      {/* Uncommitted changes -> Changes / Commit panel */}
      {changeCount > 0 && (
        <button
          onClick={() => navigate("changes")}
          title={`${changeCount} uncommitted change(s)`}
          className="th-no-drag flex items-center gap-1.5 rounded-control px-1.5 py-1 text-xs text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-status-drifted" />
          {changeCount}
        </button>
      )}

      {/* Conflict resolver entry point; also flags a resolved-but-unfinished
          merge so the concluding commit is never forgotten */}
      {(conflictCount > 0 || conflicts?.merging) && (
        <button
          onClick={() => navigate("merge")}
          title="Resolve merge conflicts"
          className="th-no-drag flex items-center gap-1.5 rounded-control border border-status-failed/30 bg-status-failed/10 px-2 py-1 text-xs font-medium text-status-failed hover:bg-status-failed/20"
        >
          <GitMerge size={12} />
          {conflictCount > 0
            ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`
            : "finish merge"}
        </button>
      )}

      <div data-tauri-drag-region className="flex-1" />

      {/* Command palette */}
      <button
        onClick={togglePalette}
        className="th-no-drag flex items-center gap-2 rounded-control border border-border-subtle bg-bg-base px-2.5 py-1 text-xs text-text-muted hover:border-border-strong"
      >
        <Search size={12} />
        <span>Search</span>
        <kbd className="rounded bg-bg-surface-2 px-1 font-mono text-[10px] text-text-secondary">
          ⌘K
        </kbd>
      </button>

      {/* Assistant panel toggle */}
      <button
        onClick={toggleAssistant}
        title="Toggle assistant (⌘J)"
        className={cn(
          "th-no-drag flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-xs font-medium transition-colors",
          assistantOpen
            ? "border-brand-accent/40 bg-brand-accent/10 text-brand-accent"
            : "border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary",
        )}
      >
        <Sparkles size={12} className={assistantOpen ? "" : "text-brand-accent"} />
        Assistant
      </button>

      {/* Sync */}
      <button
        onClick={syncFlow.sync}
        disabled={syncFlow.pending}
        className={cn(
          "th-no-drag flex items-center gap-1.5 rounded-control px-2.5 py-1 text-xs font-medium",
          "bg-brand-primary text-bg-base hover:bg-brand-primary/90 disabled:opacity-60",
        )}
      >
        {syncFlow.pending ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <RefreshCw size={12} />
        )}
        Sync
      </button>
    </header>
  );
}
