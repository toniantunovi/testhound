import { cn } from "@/lib/utils";
import type {
  AutomationState,
  Priority,
  ResultStatus,
  RunState,
} from "@/lib/types";
import {
  Archive,
  Check,
  CircleDashed,
  CircleDot,
  Loader2,
  PlayCircle,
  TriangleAlert,
  X,
} from "lucide-react";

/** Base pill. Status is never color-only: callers pair a dot/icon + label. */
export function Badge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-control px-1.5 py-0.5 text-xs font-medium",
        "border border-border-subtle bg-bg-surface-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

function Dot({ className }: { className?: string }) {
  return <span className={cn("h-1.5 w-1.5 rounded-full", className)} />;
}

const priorityColor: Record<Priority, string> = {
  low: "bg-status-skipped",
  medium: "bg-brand-primary",
  high: "bg-status-blocked",
  critical: "bg-status-failed",
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
      <Dot className={priorityColor[priority]} />
      <span className="capitalize">{priority}</span>
    </span>
  );
}

/** With `onClick` the badge becomes a link to the case's row in the
 *  Automation & Coverage view. */
export function AutomationBadge({
  state,
  onClick,
}: {
  state: AutomationState;
  onClick?: () => void;
}) {
  const badge = automationBadge(state);
  if (!onClick) return badge;
  return (
    <button
      type="button"
      title="Show in Automation & Coverage"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded-control transition-opacity hover:opacity-75"
    >
      {badge}
    </button>
  );
}

function automationBadge(state: AutomationState) {
  switch (state) {
    case "linked":
      return (
        <Badge className="border-status-passed/25 bg-status-passed/10 text-status-passed">
          <Check size={11} strokeWidth={2.5} /> Automated
        </Badge>
      );
    case "drifted":
      return (
        <Badge className="border-status-drifted/25 bg-status-drifted/10 text-status-drifted">
          <TriangleAlert size={11} /> Drifted
        </Badge>
      );
    case "generating":
      return (
        <Badge className="border-brand-accent/25 bg-brand-accent/10 text-brand-accent">
          <Loader2 size={11} className="animate-spin" /> Generating
        </Badge>
      );
    case "failed":
      return (
        <Badge className="border-status-failed/25 bg-status-failed/10 text-status-failed">
          <X size={11} /> Failed
        </Badge>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
          <Dot className="bg-status-skipped" /> Not aut.
        </span>
      );
  }
}

const resultColor: Record<ResultStatus, string> = {
  untested: "bg-status-skipped/10 text-status-skipped border-status-skipped/25",
  passed: "bg-status-passed/10 text-status-passed border-status-passed/25",
  failed: "bg-status-failed/10 text-status-failed border-status-failed/25",
  blocked: "bg-status-blocked/10 text-status-blocked border-status-blocked/25",
  retest: "bg-status-retest/10 text-status-retest border-status-retest/25",
  skipped: "bg-status-skipped/10 text-status-skipped border-status-skipped/25",
};

export function StatusBadge({ status }: { status: ResultStatus }) {
  return (
    <Badge className={cn("capitalize", resultColor[status])}>
      <CircleDot size={11} /> {status}
    </Badge>
  );
}

const runStateMeta: Record<
  RunState,
  { label: string; className: string; icon: typeof CircleDot }
> = {
  planned: {
    label: "Planned",
    className: "border-status-skipped/25 bg-status-skipped/10 text-status-skipped",
    icon: CircleDashed,
  },
  in_progress: {
    label: "In progress",
    className: "border-brand-primary/25 bg-brand-primary/10 text-brand-primary",
    icon: PlayCircle,
  },
  complete: {
    label: "Complete",
    className: "border-status-passed/25 bg-status-passed/10 text-status-passed",
    icon: Check,
  },
  archived: {
    label: "Archived",
    className: "border-border-subtle bg-bg-surface-2 text-text-muted",
    icon: Archive,
  },
};

export function RunStateBadge({ state }: { state: RunState }) {
  const meta = runStateMeta[state];
  const Icon = meta.icon;
  return (
    <Badge className={meta.className}>
      <Icon size={11} /> {meta.label}
    </Badge>
  );
}
