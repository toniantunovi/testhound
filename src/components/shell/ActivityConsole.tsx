import { ChevronUp, Circle, Terminal } from "lucide-react";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";

export function ActivityConsole() {
  const open = useSession((s) => s.activityOpen);
  const toggle = useSession((s) => s.toggleActivity);

  return (
    <div className="shrink-0 border-t border-border-subtle bg-bg-surface">
      <button
        onClick={toggle}
        className="flex h-8 w-full items-center gap-2 px-3 text-xs text-text-secondary hover:text-text-primary"
      >
        <Terminal size={13} className="text-text-muted" />
        <span className="font-medium text-text-primary">Activity</span>
        <span className="flex items-center gap-1 text-text-muted">
          <Circle size={7} className="fill-status-passed text-status-passed" />
          Idle
        </span>
        <span className="text-text-muted">
          · Last run 92% passed (2m ago)
        </span>
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
        <div className="h-48 overflow-auto border-t border-border-subtle bg-bg-base px-3 py-2 font-mono text-xs text-text-secondary">
          <div className="text-text-muted">
            $ testhound activity log
          </div>
          <div className="mt-1">
            <span className="text-brand-accent">agent</span> idle · no active
            generation
          </div>
          <div>
            <span className="text-status-passed">run</span> last regression:
            207/225 passed
          </div>
          <div className="text-text-muted">
            Waiting for the next action. Generate a spec or start a run to stream
            output here.
          </div>
        </div>
      )}
    </div>
  );
}
