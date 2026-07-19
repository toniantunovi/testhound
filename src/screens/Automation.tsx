import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  FileCode,
  FileWarning,
  KeyRound,
  RefreshCw,
  Save,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { Coverage, CoverageRow } from "@/lib/types";
import { useAssistant } from "@/store/assistant";
import { useSession } from "@/store/session";
import { usePlaywrightSetup } from "@/store/playwrightSetup";
import { AutomationBadge, PriorityBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SpecEditorModal } from "./SpecEditorModal";
import { cn } from "@/lib/utils";

type Tab = "all" | "unautomated" | "drifted" | "orphans" | "setup";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All cases" },
  { id: "unautomated", label: "Unautomated P1" },
  { id: "drifted", label: "Drifted" },
  { id: "orphans", label: "Orphan specs" },
  { id: "setup", label: "Setup" },
];

export function Automation() {
  const [tab, setTab] = useState<Tab>("all");
  // Repo-relative path of the spec being viewed/edited, if the modal is open.
  const [openSpecPath, setOpenSpecPath] = useState<string | null>(null);
  const startGeneration = useAssistant((s) => s.startGeneration);
  const openCase = useSession((s) => s.openCase);
  const focusCase = useSession((s) => s.automationFocus);
  const clearFocus = useSession((s) => s.clearAutomationFocus);

  const { data: cov, isLoading } = useQuery({
    queryKey: ["coverage"],
    queryFn: api.coverage,
  });

  const rows = useMemo(() => filterRows(cov, tab), [cov, tab]);

  // Arriving from a case's automation badge: bring the case's row into view
  // on the "All cases" tab, then let the highlight fade.
  useEffect(() => {
    if (!focusCase || !cov) return;
    if (tab !== "all") {
      setTab("all");
      return;
    }
    document
      .querySelector(`[data-case-row="${focusCase}"]`)
      ?.scrollIntoView({ block: "center" });
    const timer = setTimeout(clearFocus, 2000);
    return () => clearTimeout(timer);
  }, [focusCase, cov, tab, clearFocus]);

  // Stage the generation prompt in the assistant composer; the user reviews,
  // optionally edits, and sends it themselves.
  const generate = (row: CoverageRow, update: boolean) =>
    api
      .generationPrompt(row.case, update)
      .then((p) => startGeneration(row.case, update, p))
      .catch((e) => window.alert(errMsg(e)));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border-subtle px-8 py-5">
        <h1 className="text-lg font-semibold">Automation &amp; Coverage</h1>
        <p className="mt-0.5 text-xs text-text-muted">
          What&apos;s automated across cases, what&apos;s drifted, and which
          specs no longer map to a case.
        </p>
      </div>

      {/* Metrics */}
      {cov && (
        <div className="grid grid-cols-5 gap-px border-b border-border-subtle bg-border-subtle">
          <Metric
            label="Coverage"
            value={`${cov.coveragePct}%`}
            sub={`${cov.automated}/${cov.totalActive} active`}
            accent
          />
          <Metric label="Automated" value={cov.automated} />
          <Metric
            label="Drifted"
            value={cov.drifted}
            tone={cov.drifted > 0 ? "warn" : undefined}
          />
          <Metric
            label="Unautomated P1"
            value={cov.p1Unautomated}
            tone={cov.p1Unautomated > 0 ? "warn" : undefined}
          />
          <Metric label="Orphan specs" value={cov.orphans.length} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border-subtle px-6 py-2">
        {TABS.map((t) => {
          const count = tabCount(cov, t.id);
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-control px-2.5 py-1 text-xs transition-colors",
                tab === t.id
                  ? "bg-bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:bg-bg-surface-2/60 hover:text-text-primary",
              )}
            >
              {t.label}
              {count !== null && (
                <span className="font-mono text-[10px] text-text-muted">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "setup" ? (
          <SetupPanel />
        ) : isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Loading coverage…
          </div>
        ) : tab === "orphans" ? (
          <OrphanList orphans={cov?.orphans ?? []} onView={setOpenSpecPath} />
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Nothing here. {tab === "drifted" ? "No specs have drifted." : ""}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-bg-base">
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-muted">
                <th className="w-24 py-2 pl-6 font-medium">ID</th>
                <th className="py-2 font-medium">Case</th>
                <th className="w-28 py-2 font-medium">Priority</th>
                <th className="w-36 py-2 font-medium">State</th>
                <th className="w-40 py-2 pr-6 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.case}
                  data-case-row={row.case}
                  className={cn(
                    "border-b border-border-subtle/60 align-top transition-colors duration-700 hover:bg-bg-surface/60",
                    focusCase === row.case && "bg-brand-primary/15",
                  )}
                >
                  <td className="py-3 pl-6 font-mono text-xs text-brand-primary">
                    <button onClick={() => openCase(row.case)}>{row.case}</button>
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={() => openCase(row.case)}
                      className="text-left text-text-primary hover:underline"
                    >
                      {row.title}
                    </button>
                    <div className="mt-1 flex flex-col items-start gap-0.5">
                      {row.specs.map((s) => (
                        <button
                          key={s}
                          title="View and edit the spec code"
                          onClick={() => setOpenSpecPath(s.split("#")[0])}
                          className="flex items-center gap-1.5 rounded-control font-mono text-[11px] text-text-muted hover:text-text-primary hover:underline"
                        >
                          <FileCode size={10} className="text-brand-accent" />
                          {s}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="py-3">
                    <PriorityBadge priority={row.priority} />
                  </td>
                  <td className="py-3">
                    <AutomationBadge state={row.state} />
                  </td>
                  <td className="py-3 pr-6">
                    <div className="flex flex-col items-start gap-1.5">
                      <RowAction row={row} onGenerate={generate} />
                      {row.specs.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="View and edit the spec code"
                          onClick={() =>
                            setOpenSpecPath(row.specs[0].split("#")[0])
                          }
                        >
                          <FileCode size={12} className="text-brand-accent" />
                          View code
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openSpecPath && (
        <SpecEditorModal
          path={openSpecPath}
          onClose={() => setOpenSpecPath(null)}
        />
      )}
    </div>
  );
}

function RowAction({
  row,
  onGenerate,
}: {
  row: CoverageRow;
  onGenerate: (row: CoverageRow, update: boolean) => void;
}) {
  if (row.state === "drifted") {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="border-status-drifted/40 text-status-drifted"
        onClick={() => onGenerate(row, true)}
      >
        <RefreshCw size={12} /> Update
      </Button>
    );
  }
  if (row.state === "linked") {
    return (
      <Button variant="ghost" size="sm" onClick={() => onGenerate(row, false)}>
        <Sparkles size={12} /> Regenerate
      </Button>
    );
  }
  return (
    <Button variant="secondary" size="sm" onClick={() => onGenerate(row, false)}>
      <Sparkles size={12} className="text-brand-accent" /> Generate
    </Button>
  );
}

const SETUP_PLACEHOLDER = `Everything an agent (or a new teammate) needs to automate tests here, e.g.:

## Starting the app
- \`pnpm dev\`, app on http://localhost:3000

## Environments
- local: http://localhost:3000, staging: https://staging.example.com

## Test accounts
- Standard user: qa-user@example.com (password in TEST_USER_PASSWORD)
- Admin: qa-admin@example.com (password in TEST_ADMIN_PASSWORD)

## Data seeding / reset
- \`pnpm db:seed\` before destructive flows

## Conventions
- Auth via the storageState setup project, do not log in per test
- Prefer getByRole/getByTestId; fixtures live in tests/fixtures/`;

/** General test setup: detected Playwright facts, the committed setup notes
 *  fed to agents, and the machine-local target env where credentials live. */
function SetupPanel() {
  const qc = useQueryClient();
  const navigate = useSession((s) => s.navigate);
  const openPwSetup = usePlaywrightSetup((s) => s.open);
  const pwInitializing = usePlaywrightSetup((s) => s.initializing);

  const { data: pw } = useQuery({
    queryKey: ["playwright-info"],
    queryFn: api.playwrightInfo,
  });
  const { data: target } = useQuery({
    queryKey: ["test-target"],
    queryFn: api.getTestTarget,
  });
  const { data: setup } = useQuery({
    queryKey: ["automation-setup"],
    queryFn: api.automationSetup,
  });

  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? setup ?? "";
  const dirty = draft !== null && draft !== (setup ?? "");

  const save = useMutation({
    mutationFn: (content: string) => api.saveAutomationSetup(content),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["automation-setup"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const envKeys = Object.keys(target?.env ?? {});

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      {/* Detected facts */}
      <section className="rounded-card border border-border-subtle bg-bg-surface p-4">
        <h2 className="text-sm font-semibold text-text-primary">Detected</h2>
        <dl className="mt-2 grid grid-cols-[140px_1fr] gap-y-1.5 text-xs">
          <dt className="text-text-muted">Playwright config</dt>
          <dd className="font-mono text-text-secondary">
            {pw?.config ?? (pw?.detected === false ? "not detected" : "…")}
          </dd>
          <dt className="text-text-muted">Local binary</dt>
          <dd className="text-text-secondary">
            {pw ? (pw.localBinary ? "node_modules/.bin/playwright" : "not installed") : "…"}
          </dd>
          <dt className="text-text-muted">Base URL</dt>
          <dd className="font-mono text-text-secondary">
            {target ? (target.baseUrl?.trim() || "not set") : "…"}
          </dd>
        </dl>
        {pw && (!pw.detected || !pw.localBinary) && (
          <div className="mt-3 flex items-start gap-2 rounded-card border border-status-blocked/30 bg-status-blocked/10 p-3 text-xs text-status-blocked">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">
              {pw.detected
                ? "A Playwright config exists but no local Playwright install was found. Agents need it to write and verify specs."
                : "Playwright is not set up in this repo. Agents need it to write and verify specs."}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={pwInitializing}
              onClick={openPwSetup}
            >
              <Sparkles size={12} className="text-brand-accent" />
              {pwInitializing ? "Initializing…" : "Set up with assistant"}
            </Button>
          </div>
        )}
      </section>

      {/* Committed setup notes */}
      <section className="rounded-card border border-border-subtle bg-bg-surface p-4">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold text-text-primary">
            Setup notes
          </h2>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate(text)}
          >
            {save.isSuccess && !dirty ? <Check size={13} /> : <Save size={13} />}
            {dirty ? "Save" : "Saved"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          Committed to the repo as{" "}
          <span className="font-mono">automation/setup.md</span> and handed to
          the agent with every generation prompt and assistant turn: how to
          start the app, environments, test accounts, seeding, and selector
          conventions. Reference credential env var names here; never paste
          secret values.
        </p>
        <textarea
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={SETUP_PLACEHOLDER}
          spellCheck={false}
          className="selectable mt-3 h-72 w-full resize-y rounded-card border border-border-subtle bg-bg-base p-3 font-mono text-[12px] leading-relaxed text-text-primary placeholder:text-text-muted/60 focus:border-border-strong focus:outline-none"
        />
      </section>

      {/* Machine-local environment / credentials */}
      <section className="rounded-card border border-border-subtle bg-bg-surface p-4">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold text-text-primary">
            Environment variables
          </h2>
          <Button variant="secondary" size="sm" onClick={() => navigate("settings")}>
            Edit in Settings
          </Button>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          Stored locally (gitignored) per machine and exported to every
          Playwright run and agent session, so specs and agents read secrets
          from the environment instead of files.
        </p>
        {envKeys.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {envKeys.map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-1.5 rounded-control border border-border-subtle bg-bg-base px-2 py-1 font-mono text-[11px] text-text-secondary"
              >
                <KeyRound size={11} className="text-brand-accent" />
                {k}
                <span className="text-status-passed">set</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-text-muted">
            None configured on this machine.
          </p>
        )}
      </section>
    </div>
  );
}

function OrphanList({
  orphans,
  onView,
}: {
  orphans: string[];
  onView: (path: string) => void;
}) {
  if (orphans.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        No orphan specs. Every spec on disk maps to a case.
      </div>
    );
  }
  return (
    <div className="p-6">
      <p className="mb-3 text-xs text-text-secondary">
        These spec files are not referenced by any case. Link them from a case
        editor, or delete them if they&apos;re obsolete.
      </p>
      <div className="flex flex-col gap-1.5">
        {orphans.map((path) => (
          <button
            key={path}
            title="View and edit the spec code"
            onClick={() => onView(path)}
            className="flex items-center gap-2 rounded-card border border-border-subtle bg-bg-surface px-3 py-2 text-left font-mono text-xs text-text-secondary hover:border-border-strong hover:text-text-primary"
          >
            <FileWarning size={13} className="text-status-blocked" />
            {path}
          </button>
        ))}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  accent,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  tone?: "warn";
}) {
  return (
    <div className="bg-bg-base px-6 py-4">
      <div className="text-[11px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          accent && "text-brand-primary",
          tone === "warn" && "text-status-drifted",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-text-muted">{sub}</div>}
    </div>
  );
}

function filterRows(cov: Coverage | undefined, tab: Tab): CoverageRow[] {
  if (!cov) return [];
  switch (tab) {
    case "unautomated":
      return cov.rows.filter(
        (r) =>
          r.status === "active" &&
          r.state === "none" &&
          (r.priority === "high" || r.priority === "critical"),
      );
    case "drifted":
      return cov.rows.filter((r) => r.state === "drifted");
    case "orphans":
    case "setup":
      return [];
    default:
      return cov.rows;
  }
}

function tabCount(cov: Coverage | undefined, tab: Tab): number | null {
  if (!cov) return null;
  switch (tab) {
    case "all":
      return cov.rows.length;
    case "unautomated":
      return cov.p1Unautomated;
    case "drifted":
      return cov.drifted;
    case "orphans":
      return cov.orphans.length;
    case "setup":
      return null;
  }
}
