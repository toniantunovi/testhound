import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
  GitMerge,
  RefreshCw,
  Search,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";

export function RepoBar() {
  const project = useSession((s) => s.project);
  const navigate = useSession((s) => s.navigate);
  const { data: git } = useQuery({
    queryKey: ["git-status"],
    queryFn: api.gitStatus,
    refetchInterval: 5000,
    enabled: !!project,
  });
  const { data: conflicts } = useQuery({
    queryKey: ["conflicts"],
    queryFn: api.listConflicts,
    refetchInterval: 5000,
    enabled: !!project,
  });
  const conflictCount =
    (conflicts?.cases.length ?? 0) + (conflicts?.other.length ?? 0);

  return (
    <header className="th-drag flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle bg-bg-surface px-3 pl-20">
      {/* Brand */}
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-brand-primary shadow-[0_0_8px_rgba(110,139,255,0.7)]" />
        <span className="text-sm font-semibold tracking-tight">TestHound</span>
      </div>

      {/* Project switcher */}
      <button className="th-no-drag flex items-center gap-1 rounded-control px-2 py-1 text-sm text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary">
        {project?.name ?? "No project"}
        <ChevronDown size={13} className="text-text-muted" />
      </button>

      {/* Branch */}
      <button className="th-no-drag flex items-center gap-1.5 rounded-control border border-border-subtle bg-bg-surface-2 px-2 py-1 text-xs hover:border-border-strong">
        <GitBranch size={12} className="text-brand-accent" />
        <span className="font-mono text-text-primary">
          {git?.branch ?? project?.branch ?? "-"}
        </span>
        <ChevronDown size={12} className="text-text-muted" />
      </button>

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

      {/* Uncommitted-changes dot */}
      {git && !git.clean && (
        <span
          title={`${git.changed.length} uncommitted change(s)`}
          className="h-1.5 w-1.5 rounded-full bg-status-drifted"
        />
      )}

      {/* Conflict resolver entry point */}
      {conflictCount > 0 && (
        <button
          onClick={() => navigate("merge")}
          title="Resolve merge conflicts"
          className="th-no-drag flex items-center gap-1.5 rounded-control border border-status-failed/30 bg-status-failed/10 px-2 py-1 text-xs font-medium text-status-failed hover:bg-status-failed/20"
        >
          <GitMerge size={12} />
          {conflictCount} conflict{conflictCount === 1 ? "" : "s"}
        </button>
      )}

      <div className="flex-1" />

      {/* Command palette hint */}
      <button className="th-no-drag flex items-center gap-2 rounded-control border border-border-subtle bg-bg-base px-2.5 py-1 text-xs text-text-muted hover:border-border-strong">
        <Search size={12} />
        <span>Search</span>
        <kbd className="rounded bg-bg-surface-2 px-1 font-mono text-[10px] text-text-secondary">
          ⌘K
        </kbd>
      </button>

      {/* Sync */}
      <button
        className={cn(
          "th-no-drag flex items-center gap-1.5 rounded-control px-2.5 py-1 text-xs font-medium",
          "bg-brand-primary text-bg-base hover:bg-brand-primary/90",
        )}
      >
        <RefreshCw size={12} />
        Sync
      </button>
    </header>
  );
}
