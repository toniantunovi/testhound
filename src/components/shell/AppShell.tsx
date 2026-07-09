import { useEffect } from "react";
import { RepoBar } from "./RepoBar";
import { Sidebar } from "./Sidebar";
import { ActivityConsole } from "./ActivityConsole";
import { CommandPalette } from "./CommandPalette";
import { useRunEvents } from "@/lib/useRunEvents";
import { useSession } from "@/store/session";
import { Dashboard } from "@/screens/Dashboard";
import { Cases } from "@/screens/Cases";
import { CaseEditor } from "@/screens/CaseEditor";
import { CaseHistory } from "@/screens/CaseHistory";
import { Runs } from "@/screens/Runs";
import { NewRun } from "@/screens/NewRun";
import { RunView } from "@/screens/RunView";
import { Automation } from "@/screens/Automation";
import { Changes } from "@/screens/Changes";
import { MergeView } from "@/screens/MergeView";
import { Settings } from "@/screens/Settings";
import { GenerationDrawer } from "@/screens/GenerationDrawer";
import { Placeholder } from "@/screens/Placeholder";

export function AppShell() {
  const view = useSession((s) => s.view);
  const togglePalette = useSession((s) => s.togglePalette);
  useRunEvents();

  // ⌘K / Ctrl-K opens the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <RepoBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden bg-bg-base">
          {view === "dashboard" && <Dashboard />}
          {view === "cases" && <Cases />}
          {view === "case-editor" && <CaseEditor />}
          {view === "case-history" && <CaseHistory />}
          {view === "runs" && <Runs />}
          {view === "new-run" && <NewRun />}
          {view === "run-view" && <RunView />}
          {view === "automation" && <Automation />}
          {view === "changes" && <Changes />}
          {view === "merge" && <MergeView />}
          {view === "reports" && (
            <Placeholder
              title="Reports"
              blurb="Pass rate over time, per-suite health, and flakiness trends derived from Git history."
            />
          )}
          {view === "settings" && <Settings />}
        </main>
      </div>
      <ActivityConsole />
      <GenerationDrawer />
      <CommandPalette />
    </div>
  );
}
