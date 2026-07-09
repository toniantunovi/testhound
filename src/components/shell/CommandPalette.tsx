import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  GitCommitHorizontal,
  LayoutGrid,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Terminal,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { useSession, type View } from "@/store/session";
import { useActivity } from "@/store/activity";
import { cn } from "@/lib/utils";

interface Command {
  id: string;
  label: string;
  section: string;
  icon: typeof LayoutGrid;
  run: () => void;
}

/** ⌘K command palette (docs/06-ui-ux.md §6.4). Keyboard-first navigation and
 *  quick actions over the whole app. */
export function CommandPalette() {
  const open = useSession((s) => s.paletteOpen);
  const setPalette = useSession((s) => s.setPalette);
  const navigate = useSession((s) => s.navigate);
  const newRun = useSession((s) => s.newRun);
  const toggleActivity = useSession((s) => s.toggleActivity);
  const push = useActivity((s) => s.push);
  const finish = useActivity((s) => s.finish);
  const qc = useQueryClient();

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (view: View, label: string, icon: Command["icon"]): Command => ({
      id: `nav:${view}`,
      label,
      section: "Navigate",
      icon,
      run: () => navigate(view),
    });
    const sync = async () => {
      try {
        push("$ git pull --ff-only && git push");
        const out = await api.syncRepo();
        out.split("\n").forEach((l) => l && push(l));
        finish("Synced");
        qc.invalidateQueries({ queryKey: ["git-status"] });
      } catch (e) {
        push(`error: ${errMsg(e)}`);
        finish(null);
      }
    };
    return [
      go("dashboard", "Go to Dashboard", LayoutGrid),
      go("cases", "Go to Test Cases", ListChecks),
      go("runs", "Go to Runs", Play),
      go("automation", "Go to Automation", Sparkles),
      go("reports", "Go to Reports", BarChart3),
      go("changes", "Go to Changes", GitCommitHorizontal),
      go("settings", "Go to Settings", SettingsIcon),
      {
        id: "action:new-run",
        label: "New run",
        section: "Actions",
        icon: Plus,
        run: newRun,
      },
      {
        id: "action:sync",
        label: "Sync (pull, then push)",
        section: "Actions",
        icon: RefreshCw,
        run: sync,
      },
      {
        id: "action:activity",
        label: "Toggle activity console",
        section: "Actions",
        icon: Terminal,
        run: toggleActivity,
      },
    ];
  }, [navigate, newRun, toggleActivity, push, finish, qc]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    setPalette(false);
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setPalette(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(index);
    }
  };

  let lastSection = "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={() => setPalette(false)}
    >
      <div
        className="w-[560px] max-w-[90vw] overflow-hidden rounded-card border border-border-strong bg-bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command or search…"
          className="w-full border-b border-border-subtle bg-transparent px-4 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
        />
        <div className="max-h-[50vh] overflow-auto py-1.5">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-text-muted">
              No matching commands.
            </div>
          )}
          {filtered.map((c, i) => {
            const header = c.section !== lastSection ? c.section : null;
            lastSection = c.section;
            const Icon = c.icon;
            return (
              <div key={c.id}>
                {header && (
                  <div className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                    {header}
                  </div>
                )}
                <button
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => runAt(i)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                    i === index
                      ? "bg-bg-surface-2 text-text-primary"
                      : "text-text-secondary",
                  )}
                >
                  <Icon
                    size={15}
                    className={i === index ? "text-brand-primary" : "text-text-muted"}
                  />
                  {c.label}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
