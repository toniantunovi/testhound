import {
  LayoutGrid,
  ListChecks,
  Play,
  Sparkles,
  BarChart3,
  Settings,
} from "lucide-react";
import { useSession, type View } from "@/store/session";
import { cn } from "@/lib/utils";

const items: { view: View; label: string; icon: typeof LayoutGrid }[] = [
  { view: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { view: "cases", label: "Test Cases", icon: ListChecks },
  { view: "runs", label: "Runs", icon: Play },
  { view: "automation", label: "Automation", icon: Sparkles },
  { view: "reports", label: "Reports", icon: BarChart3 },
];

export function Sidebar() {
  const view = useSession((s) => s.view);
  const navigate = useSession((s) => s.navigate);

  const isActive = (v: View) =>
    view === v ||
    (v === "cases" && view === "case-editor") ||
    (v === "runs" && (view === "new-run" || view === "run-view"));

  return (
    <nav className="flex w-52 shrink-0 flex-col border-r border-border-subtle bg-bg-surface px-2 py-3">
      <div className="flex flex-col gap-0.5">
        {items.map(({ view: v, label, icon: Icon }) => (
          <button
            key={v}
            onClick={() => navigate(v)}
            className={cn(
              "flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm transition-colors",
              isActive(v)
                ? "bg-bg-surface-2 text-text-primary"
                : "text-text-secondary hover:bg-bg-surface-2/60 hover:text-text-primary",
            )}
          >
            <Icon
              size={16}
              className={isActive(v) ? "text-brand-primary" : "text-text-muted"}
            />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <button
        onClick={() => navigate("settings")}
        className={cn(
          "flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm transition-colors",
          view === "settings"
            ? "bg-bg-surface-2 text-text-primary"
            : "text-text-secondary hover:bg-bg-surface-2/60 hover:text-text-primary",
        )}
      >
        <Settings
          size={16}
          className={view === "settings" ? "text-brand-primary" : "text-text-muted"}
        />
        Settings
      </button>
    </nav>
  );
}
