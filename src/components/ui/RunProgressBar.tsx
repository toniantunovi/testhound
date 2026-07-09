import type { RunProgress } from "@/lib/types";
import { cn } from "@/lib/utils";

const segments: { key: keyof RunProgress; color: string }[] = [
  { key: "passed", color: "bg-status-passed" },
  { key: "failed", color: "bg-status-failed" },
  { key: "blocked", color: "bg-status-blocked" },
  { key: "retest", color: "bg-status-retest" },
  { key: "skipped", color: "bg-status-skipped" },
];

/** A segmented bar showing the status breakdown of a run's cases. Untested is
 *  the uncolored remainder of the track. */
export function RunProgressBar({
  progress,
  className,
}: {
  progress: RunProgress;
  className?: string;
}) {
  const total = Math.max(progress.total, 1);
  return (
    <div
      className={cn(
        "flex h-1.5 w-full overflow-hidden rounded-full bg-bg-surface-2",
        className,
      )}
    >
      {segments.map(({ key, color }) => {
        const value = progress[key];
        if (!value) return null;
        return (
          <div
            key={key}
            className={color}
            style={{ width: `${(value / total) * 100}%` }}
          />
        );
      })}
    </div>
  );
}
