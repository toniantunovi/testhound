import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCode, FileWarning, RefreshCw, Sparkles } from "lucide-react";
import { api } from "@/lib/ipc";
import type { Coverage, CoverageRow } from "@/lib/types";
import { useAgentDrawer } from "@/store/agent";
import { useSession } from "@/store/session";
import { AutomationBadge, PriorityBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

type Tab = "all" | "unautomated" | "drifted" | "orphans";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All cases" },
  { id: "unautomated", label: "Unautomated P1" },
  { id: "drifted", label: "Drifted" },
  { id: "orphans", label: "Orphan specs" },
];

export function Automation() {
  const [tab, setTab] = useState<Tab>("all");
  const openDrawer = useAgentDrawer((s) => s.open);
  const openCase = useSession((s) => s.openCase);

  const { data: cov, isLoading } = useQuery({
    queryKey: ["coverage"],
    queryFn: api.coverage,
  });

  const rows = useMemo(() => filterRows(cov, tab), [cov, tab]);

  const generate = (row: CoverageRow, update: boolean) =>
    openDrawer({ caseId: row.case, caseTitle: row.title, update });

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
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Loading coverage…
          </div>
        ) : tab === "orphans" ? (
          <OrphanList orphans={cov?.orphans ?? []} />
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
                  className="border-b border-border-subtle/60 align-top hover:bg-bg-surface/60"
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
                    <div className="mt-1 flex flex-col gap-0.5">
                      {row.specs.map((s) => (
                        <span
                          key={s}
                          className="flex items-center gap-1.5 font-mono text-[11px] text-text-muted"
                        >
                          <FileCode size={10} className="text-brand-accent" />
                          {s}
                        </span>
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
                    <RowAction row={row} onGenerate={generate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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

function OrphanList({ orphans }: { orphans: string[] }) {
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
          <div
            key={path}
            className="flex items-center gap-2 rounded-card border border-border-subtle bg-bg-surface px-3 py-2 font-mono text-xs text-text-secondary"
          >
            <FileWarning size={13} className="text-status-blocked" />
            {path}
          </div>
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
  }
}
