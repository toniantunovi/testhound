import { useQuery } from "@tanstack/react-query";
import {
  TrendingUp,
  TriangleAlert,
  Target,
  CircleDot,
} from "lucide-react";
import { api } from "@/lib/ipc";
import type { RunSummary } from "@/lib/types";
import { useSession } from "@/store/session";
import { cn, relativeTime } from "@/lib/utils";
import { RunProgressBar } from "@/components/ui/RunProgressBar";

export function Dashboard() {
  const project = useSession((s) => s.project);
  const openRun = useSession((s) => s.openRun);
  const navigate = useSession((s) => s.navigate);
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });

  const coverage = data?.coveragePct ?? 0;
  const runs = data?.runs ?? [];
  const passRate = data?.lastRunPassRate;

  return (
    <div className="h-full overflow-auto p-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-0.5 text-sm text-text-secondary">
          {project?.name} ·{" "}
          <span className="font-mono text-text-muted">
            branch {project?.branch}
          </span>
        </p>
      </header>

      {/* KPI tiles */}
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi
          label="Active cases"
          value={data?.activeCases ?? 0}
          hint={`${data?.totalCases ?? 0} total`}
        />
        <Kpi
          label="Automation coverage"
          value={`${coverage}%`}
          hint={`${data?.automated ?? 0} automated`}
          accent
        />
        <Kpi
          label="Last run pass rate"
          value={passRate != null ? `${passRate}%` : "-"}
          hint={
            data?.lastRunFailed
              ? `${data.lastRunFailed} failed`
              : "no failures"
          }
        />
        <Kpi label="Drifted specs" value={data?.drifted ?? 0} hint="need update" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Pass rate over time */}
        <Card title="Pass rate over time" subtitle="Pass rate per run, oldest to newest">
          <PassRateChart trend={data?.passRateTrend ?? []} />
        </Card>

        {/* Suite health */}
        <Card title="Suite health">
          <div className="flex flex-col gap-3">
            {(data?.suites ?? []).map((s) => {
              const pct =
                s.caseCount > 0
                  ? Math.round((s.automated / s.caseCount) * 100)
                  : 0;
              return (
                <div key={s.id}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-text-secondary">{s.name}</span>
                    <span className="font-mono text-text-muted">{pct}%</span>
                  </div>
                  <Meter pct={pct} />
                </div>
              );
            })}
            {(data?.suites?.length ?? 0) === 0 && (
              <p className="text-sm text-text-muted">No suites yet.</p>
            )}
          </div>
        </Card>
      </div>

      {/* Needs attention */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Recent runs">
          {runs.length === 0 ? (
            <button
              onClick={() => navigate("runs")}
              className="text-sm text-text-muted hover:text-text-primary"
            >
              No runs yet. Create one in Runs.
            </button>
          ) : (
            <div className="flex flex-col gap-3">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} onOpen={() => openRun(r.id)} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Needs attention">
          <div className="flex flex-col gap-2">
            <Attention icon={TriangleAlert} tone="drifted" label={`${data?.drifted ?? 0} specs drifted from cases`} tag="drifted" />
            <Attention icon={Target} tone="brand" label={`${data?.p1Unautomated ?? 0} P1 cases not automated`} tag="coverage" />
            <Attention icon={CircleDot} tone="failed" label={`${data?.lastRunFailed ?? 0} failed in last run`} tag="failed" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-card border border-border-subtle bg-bg-surface p-4">
      <div className="text-xs text-text-secondary">{label}</div>
      <div
        className={cn(
          "mt-2 text-[28px] font-semibold leading-none tracking-tight",
          accent && "text-brand-accent",
        )}
      >
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1 text-xs text-text-muted">
        <TrendingUp size={12} className="text-status-passed" />
        {hint}
      </div>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface p-4">
      <div className="mb-4">
        <h2 className="text-sm font-medium">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Meter({ pct }: { pct: number }) {
  const color =
    pct >= 90
      ? "bg-status-passed"
      : pct >= 75
        ? "bg-status-blocked"
        : "bg-status-failed";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-bg-surface-2">
      <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function PassRateChart({ trend }: { trend: number[] }) {
  const max = 100;
  if (trend.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-text-muted">
        No executed runs yet.
      </div>
    );
  }
  return (
    <div className="flex h-40 items-end gap-1.5">
      {trend.map((v, i) => (
        <div
          key={i}
          className="flex flex-1 flex-col justify-end"
          title={`${v}%`}
        >
          <div
            className="w-full rounded-t bg-status-failed/70"
            style={{ height: `${((max - v) / max) * 100 * 0.25}%` }}
          />
          <div
            className="w-full rounded-b bg-status-passed"
            style={{ height: `${(v / max) * 100}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  const { progress } = run;
  const executed = progress.total - progress.untested;
  const pct =
    executed === 0 ? 0 : Math.round((progress.passed / executed) * 100);
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-control px-1 py-1 text-left hover:bg-bg-surface-2/50"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text-primary">{run.name}</div>
        <div className="truncate font-mono text-xs text-text-muted">
          {run.configuration.join(" · ") || "no config"}
        </div>
      </div>
      <span className="font-mono text-xs text-text-secondary">
        {progress.passed}/{progress.total}
      </span>
      <div className="w-24">
        <RunProgressBar progress={progress} />
      </div>
      <span className="w-16 text-right text-xs text-text-muted">
        {relativeTime(run.created)}
      </span>
      <span className="w-8 text-right font-mono text-xs text-text-muted">
        {pct}%
      </span>
    </button>
  );
}

const toneMap = {
  drifted: "border-status-drifted/25 text-status-drifted",
  brand: "border-brand-primary/25 text-brand-primary",
  retest: "border-status-retest/25 text-status-retest",
  failed: "border-status-failed/25 text-status-failed",
} as const;

function Attention({
  icon: Icon,
  tone,
  label,
  tag,
}: {
  icon: typeof TriangleAlert;
  tone: keyof typeof toneMap;
  label: string;
  tag: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-control border border-border-subtle bg-bg-surface-2 px-3 py-2">
      <Icon size={14} className={toneMap[tone].split(" ")[1]} />
      <span className="flex-1 text-sm text-text-primary">{label}</span>
      <span
        className={cn(
          "rounded border px-1.5 py-0.5 font-mono text-[10px]",
          toneMap[tone],
        )}
      >
        {tag}
      </span>
    </div>
  );
}
