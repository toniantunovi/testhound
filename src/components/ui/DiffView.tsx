import { useMemo } from "react";
import { diffStat, lineDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";

/** A compact unified diff of a file's committed version against the working
 *  tree. New files render as all-additions.
 *
 *  - `showLineNumbers` renders the old/new line-number gutters (default on).
 *  - `fill` drops the fixed max-height so the diff grows to its container and
 *    scrolls there instead, for full-pane views (Changes, Case History).
 *  - `header` toggles the +N/-N summary bar (default on). */
export function DiffView({
  old,
  next,
  className,
  showLineNumbers = true,
  fill = false,
  header = true,
  title,
}: {
  old: string | null;
  next: string;
  className?: string;
  showLineNumbers?: boolean;
  fill?: boolean;
  header?: boolean;
  /** Optional path/label shown at the left of the header bar. */
  title?: string;
}) {
  const lines = useMemo(() => lineDiff(old, next), [old, next]);
  const stat = useMemo(() => diffStat(lines), [lines]);

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-card border border-border-subtle",
        className,
      )}
    >
      {header && (
        <div className="flex items-center gap-3 border-b border-border-subtle bg-bg-surface px-3 py-1.5 text-[11px]">
          {title && (
            <span className="min-w-0 flex-1 truncate font-mono text-text-muted">
              {title}
            </span>
          )}
          <span className="font-mono text-status-passed">+{stat.added}</span>
          <span className="font-mono text-status-failed">-{stat.removed}</span>
          {old === null && <span className="text-text-muted">new file</span>}
        </div>
      )}
      <div
        className={cn(
          "overflow-auto bg-bg-base font-mono text-[12px] leading-relaxed",
          fill ? "min-h-0 flex-1" : "max-h-[420px]",
        )}
      >
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              "flex",
              l.kind === "add" && "bg-status-passed/10",
              l.kind === "del" && "bg-status-failed/10",
            )}
          >
            {showLineNumbers && (
              <>
                <span className="w-10 shrink-0 select-none border-r border-border-subtle/50 px-1 text-right text-text-muted">
                  {l.oldNo ?? ""}
                </span>
                <span className="w-10 shrink-0 select-none border-r border-border-subtle/50 px-1 text-right text-text-muted">
                  {l.newNo ?? ""}
                </span>
              </>
            )}
            <span
              className={cn(
                "w-4 shrink-0 select-none text-center",
                l.kind === "add" && "text-status-passed",
                l.kind === "del" && "text-status-failed",
                l.kind === "same" && "text-text-muted",
              )}
            >
              {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
            </span>
            <span className="selectable whitespace-pre-wrap break-all pr-3 text-text-secondary">
              {l.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
