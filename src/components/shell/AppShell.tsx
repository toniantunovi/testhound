import { RepoBar } from "./RepoBar";
import { Sidebar } from "./Sidebar";
import { ActivityConsole } from "./ActivityConsole";
import { useRunEvents } from "@/lib/useRunEvents";
import { useSession } from "@/store/session";
import { Dashboard } from "@/screens/Dashboard";
import { Cases } from "@/screens/Cases";
import { CaseEditor } from "@/screens/CaseEditor";
import { Runs } from "@/screens/Runs";
import { NewRun } from "@/screens/NewRun";
import { RunView } from "@/screens/RunView";
import { Automation } from "@/screens/Automation";
import { GenerationDrawer } from "@/screens/GenerationDrawer";
import { Placeholder } from "@/screens/Placeholder";

export function AppShell() {
  const view = useSession((s) => s.view);
  useRunEvents();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <RepoBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden bg-bg-base">
          {view === "dashboard" && <Dashboard />}
          {view === "cases" && <Cases />}
          {view === "case-editor" && <CaseEditor />}
          {view === "runs" && <Runs />}
          {view === "new-run" && <NewRun />}
          {view === "run-view" && <RunView />}
          {view === "automation" && <Automation />}
          {view === "reports" && (
            <Placeholder
              title="Reports"
              blurb="Pass rate over time, per-suite health, and flakiness trends derived from Git history."
            />
          )}
          {view === "settings" && (
            <Placeholder
              title="Settings"
              blurb="Project fields and statuses, automation command, agent runners, and Git preferences."
            />
          )}
        </main>
      </div>
      <ActivityConsole />
      <GenerationDrawer />
    </div>
  );
}
