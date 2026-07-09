import { useEffect, useRef } from "react";
import { ChevronUp, Circle, Loader2, Terminal } from "lucide-react";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";
import { cn } from "@/lib/utils";

export function ActivityConsole() {
  const open = useSession((s) => s.activityOpen);
  const toggle = useSession((s) => s.toggleActivity);
  const lines = useActivity((s) => s.lines);
  const runningRunId = useActivity((s) => s.runningRunId);
  const lastSummary = useActivity((s) => s.lastSummary);
  const running = runningRunId !== null;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, open]);

  return (
    <div className="shrink-0 border-t border-border-subtle bg-bg-surface">
      <button
        onClick={toggle}
        className="flex h-8 w-full items-center gap-2 px-3 text-xs text-text-secondary hover:text-text-primary"
      >
        <Terminal size={13} className="text-text-muted" />
        <span className="font-medium text-text-primary">Activity</span>
        {running ? (
          <span className="flex items-center gap-1 text-brand-primary">
            <Loader2 size={11} className="animate-spin" />
            Running
          </span>
        ) : (
          <span className="flex items-center gap-1 text-text-muted">
            <Circle size={7} className="fill-status-passed text-status-passed" />
            Idle
          </span>
        )}
        {lastSummary && !running && (
          <span className="truncate text-text-muted">· {lastSummary}</span>
        )}
        <div className="flex-1" />
        <kbd className="rounded bg-bg-surface-2 px-1 font-mono text-[10px]">
          ⌃`
        </kbd>
        <ChevronUp
          size={14}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          ref={scrollRef}
          className="h-48 overflow-auto border-t border-border-subtle bg-bg-base px-3 py-2 font-mono text-xs text-text-secondary"
        >
          {lines.length === 0 ? (
            <div className="text-text-muted">
              Waiting for the next action. Run automated tests on a run to stream
              Playwright output here.
            </div>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
