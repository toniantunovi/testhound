import { useEffect } from "react";
import { ShieldCheck, X } from "lucide-react";
import { RepoBar } from "./RepoBar";
import { Sidebar } from "./Sidebar";
import { ActivityConsole } from "./ActivityConsole";
import { CommandPalette } from "./CommandPalette";
import { AssistantPanel } from "./AssistantPanel";
import { InitPlaywrightDialog } from "@/components/InitPlaywrightDialog";
import { useRunEvents } from "@/lib/useRunEvents";
import { useAutoSync } from "@/lib/useAutoSync";
import { useSession } from "@/store/session";
import { useAssistant } from "@/store/assistant";
import { usePrefs } from "@/store/prefs";
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
import { Reports } from "@/screens/Reports";

export function AppShell() {
  const view = useSession((s) => s.view);
  const togglePalette = useSession((s) => s.togglePalette);
  const toggleAssistant = useAssistant((s) => s.toggle);
  useRunEvents();
  useAutoSync();

  // ⌘K opens the command palette; ⌘J toggles the assistant panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        togglePalette();
      } else if (key === "j") {
        e.preventDefault();
        toggleAssistant();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, toggleAssistant]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Banner />
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
          {view === "reports" && <Reports />}
          {view === "settings" && <Settings />}
        </main>
        <AssistantPanel />
      </div>
      <ActivityConsole />
      <CommandPalette />
      <InitPlaywrightDialog />
    </div>
  );
}

/** Slim, one-time, dismissible notice explaining the anonymous telemetry
 *  (transparent opt-out). Remembered in prefs once acknowledged. */
function Banner() {
  const navigate = useSession((s) => s.navigate);
  const telemetryNoticeSeen = usePrefs((s) => s.telemetryNoticeSeen);
  const markTelemetryNoticeSeen = usePrefs((s) => s.markTelemetryNoticeSeen);

  if (telemetryNoticeSeen) return null;

  return (
    <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-surface px-4 py-2 text-xs text-text-secondary">
      <ShieldCheck size={14} className="shrink-0 text-brand-accent" />
      <span className="min-w-0 flex-1">
        TestHound shares strictly anonymous usage stats to improve the product:
        a random install id and coarse counts, never your titles, paths, repos,
        or code. Manage it any time in Settings.
      </span>
      <button
        onClick={() => {
          markTelemetryNoticeSeen();
          navigate("settings");
        }}
        className="shrink-0 rounded-control px-2 py-1 text-brand-primary hover:bg-bg-surface-2"
      >
        Review
      </button>
      <button
        onClick={markTelemetryNoticeSeen}
        title="Dismiss"
        className="shrink-0 rounded-control p-1 text-text-muted hover:bg-bg-surface-2 hover:text-text-primary"
      >
        <X size={14} />
      </button>
    </div>
  );
}
