import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FolderOpen,
  GitBranch,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { track } from "@/lib/telemetry";
import type { ProjectInfo, RepoInfo } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

export function Onboarding({ onReady }: { onReady: (p: ProjectInfo) => void }) {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [name, setName] = useState("");
  const [seed, setSeed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFolder = async () => {
    setError(null);
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      setBusy(true);
      const ri = await api.inspectRepo(selected);
      setInfo(ri);
      setName(ri.projectName ?? deriveName(ri.path));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!info) return;
    setError(null);
    setBusy(true);
    try {
      const project = info.hasProject
        ? await api.openProject(info.path)
        : await api.scaffoldProject(info.path, name || "TestHound Project", seed);
      void track("project_opened", { is_new: !info.hasProject });
      onReady(project);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-bg-base p-8">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-brand-primary/15">
            <span className="h-4 w-4 rounded-full bg-brand-primary shadow-[0_0_12px_rgba(110,139,255,0.8)]" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            Connect a repository
          </h1>
          <p className="mt-1.5 text-sm text-text-secondary">
            TestHound stores every test artifact as files in your Git repo. Point
            it at a local clone to begin.
          </p>
        </div>

        <div className="rounded-card border border-border-subtle bg-bg-surface p-5">
          {/* Step 1: choose folder */}
          <button
            onClick={pickFolder}
            disabled={busy}
            className="flex w-full items-center gap-3 rounded-control border border-dashed border-border-strong bg-bg-base px-4 py-3 text-left hover:border-brand-primary/60"
          >
            <FolderOpen size={18} className="text-brand-primary" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-primary">
                {info ? "Change folder" : "Open a local repository"}
              </div>
              <div className="truncate font-mono text-xs text-text-muted">
                {info?.path ?? "Select a directory on disk"}
              </div>
            </div>
          </button>

          {/* Detected state */}
          {info && (
            <div className="mt-4 flex flex-col gap-2">
              <DetectRow
                ok={info.isGitRepo}
                label={
                  info.isGitRepo
                    ? "Git repository detected"
                    : "Not a Git repo (one will be initialized)"
                }
              />
              <DetectRow
                ok={info.hasProject}
                neutralWhenFalse
                label={
                  info.hasProject
                    ? `Existing TestHound project “${info.projectName}”`
                    : "No TestHound project yet (will scaffold testhound/)"
                }
              />
              <DetectRow
                ok={info.playwrightDetected}
                neutralWhenFalse
                label={
                  info.playwrightDetected
                    ? "Playwright install detected"
                    : "No Playwright config found (optional)"
                }
              />

              {/* Scaffold options */}
              {!info.hasProject && (
                <div className="mt-2 rounded-control border border-border-subtle bg-bg-base p-3">
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
                    Project name
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mb-3 h-8 w-full rounded-control border border-border-subtle bg-bg-surface px-2 text-sm focus:border-border-strong focus:outline-none"
                  />
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={seed}
                      onChange={(e) => setSeed(e.target.checked)}
                      className="accent-brand-primary"
                    />
                    Seed with sample data (Acme Shop demo)
                  </label>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-control border border-status-failed/30 bg-status-failed/10 p-2.5 text-xs text-status-failed">
              <TriangleAlert size={14} className="mt-px shrink-0" />
              <span className="selectable">{error}</span>
            </div>
          )}

          <Button
            variant="primary"
            size="md"
            className="mt-5 w-full"
            disabled={!info || busy}
            onClick={connect}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {info?.hasProject ? "Open project" : "Scaffold & open"}
          </Button>
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-text-muted">
          <GitBranch size={12} />
          Auth uses your system Git credentials. TestHound stores no passwords.
        </p>
      </div>
    </div>
  );
}

function DetectRow({
  ok,
  label,
  neutralWhenFalse,
}: {
  ok: boolean;
  label: string;
  neutralWhenFalse?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full",
          ok
            ? "bg-status-passed/15 text-status-passed"
            : neutralWhenFalse
              ? "bg-bg-surface-2 text-text-muted"
              : "bg-status-blocked/15 text-status-blocked",
        )}
      >
        {ok ? <Check size={11} strokeWidth={3} /> : <span className="h-1 w-1 rounded-full bg-current" />}
      </span>
      <span className="text-text-secondary">{label}</span>
    </div>
  );
}

function deriveName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || "TestHound Project";
}
