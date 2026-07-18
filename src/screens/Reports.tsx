import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Activity, Repeat, TriangleAlert } from "lucide-react";
import { api } from "@/lib/ipc";
import type { RunDetail, RunProgress } from "@/lib/types";
import { useSession } from "@/store/session";
import { cn, relativeTime } from "@/lib/utils";
import { RunProgressBar } from "@/components/ui/RunProgressBar";
import { Button } from "@/components/ui/Button";

/** Analytics derived from the recorded run history: pass rate over time,
 *  per-suite health, and flaky cases (results that disagree across runs). */
export function Reports() {
  const project = useSession((s) => s.project);
  const openRun = useSession((s) => s.openRun);
  const openCase = useSession((s) => s.openCase);
  const navigate = useSession((s) => s.navigate);

  const { data: runs = [] } = useQuery({
    queryKey: ["runs"],
    queryFn: api.listRuns,
  });
  const { data: cov } = useQuery({ queryKey: ["coverage"], queryFn: api.coverage });

  // Run details carry per-case results, needed for per-suite pass rates and
  // flaky detection. Keyed like RunView so the cache is shared.
  const detailQueries = useQueries({
    queries: runs.map((r) => ({
      queryKey: ["run", r.id],
      queryFn: () => api.getRun(r.id),
    })),
  });
  const details = detailQueries
    .map((q) => q.data)
    .filter((d): d is RunDetail => !!d);
  const detailsLoading = runs.length > 0 && details.length < runs.length;

  // Pass rate per run, oldest to newest.
  const timeline = useMemo(
    () =>
      [...runs]
        .filter((r) => r.created)
        .sort((a, b) => (a.created! < b.created! ? -1 : 1))
        .map((r) => {
          const executed = r.progress.total - r.progress.untested;
          return {
            id: r.id,
            name: r.name,
            created: r.created,
            executed,
            total: r.progress.total,
            passRate:
              executed > 0
                ? Math.round((r.progress.passed / executed) * 100)
                : null,
          };
        }),
    [runs],
  );

  // Aggregate status mix across every run.
  const mix = useMemo<RunProgress>(() => {
    const z: RunProgress = {
      total: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      retest: 0,
      skipped: 0,
      untested: 0,
    };
    for (const r of runs) {
      (Object.keys(z) as (keyof RunProgress)[]).forEach(
        (k) => (z[k] += r.progress[k]),
      );
    }
    return z;
  }, [runs]);

  const executedTotal = mix.total - mix.untested;
  const overallPassRate =
    executedTotal > 0 ? Math.round((mix.passed / executedTotal) * 100) : null;

  // Per-case aggregation across runs -> flaky detection.
  const flaky = useMemo(() => {
    const agg = new Map<
      string,
      { title: string; suite: string; passed: number; failed: number; runs: number; attempts: number }
    >();
    for (const d of details) {
      for (const row of d.rows) {
        if (row.status === "untested") continue;
        const c =
          agg.get(row.case) ??
          { title: row.title, suite: row.suite, passed: 0, failed: 0, runs: 0, attempts: 0 };
        c.runs += 1;
        if (row.status === "passed") c.passed += 1;
        else if (row.status === "failed") c.failed += 1;
        c.attempts = Math.max(c.attempts, row.attempts ?? 0);
        agg.set(row.case, c);
      }
    }
    return [...agg.entries()]
      .map(([id, c]) => ({
        id,
        ...c,
        // Flaky = disagrees across runs (passed somewhere, failed elsewhere),
        // or a run needed more than one attempt.
        isFlaky: (c.passed > 0 && c.failed > 0) || c.attempts > 1,
      }))
      .filter((c) => c.isFlaky)
      .sort((a, b) => b.failed - a.failed || b.attempts - a.attempts);
  }, [details]);

  // Per-suite: automation coverage (from coverage) + pass rate (from results).
  const suiteResults = useMemo(() => {
    const m = new Map<string, { executed: number; passed: number }>();
    for (const d of details) {
      for (const row of d.rows) {
        if (row.status === "untested") continue;
        const s = m.get(row.suite) ?? { executed: 0, passed: 0 };
        s.executed += 1;
        if (row.status === "passed") s.passed += 1;
        m.set(row.suite, s);
      }
    }
    return m;
  }, [details]);

  const suites = (cov?.perSuite ?? []).map((s) => {
    const res = suiteResults.get(s.id);
    return {
      ...s,
      coverage: s.active > 0 ? Math.round((s.automated / s.active) * 100) : 0,
      passRate:
        res && res.executed > 0
          ? Math.round((res.passed / res.executed) * 100)
          : null,
    };
  });

  if (runs.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-text-muted">
            No runs yet, so there is nothing to report on.
          </p>
          <Button variant="primary" size="md" onClick={() => navigate("runs")}>
            Go to Runs
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header subtitle={project?.name} />
      <div className="min-h-0 flex-1 overflow-auto p-8">
        {/* KPIs */}
        <div className="mb-6 grid grid-cols-4 gap-4">
          <Kpi label="Runs recorded" value={runs.length} hint={`${executedTotal} case executions`} />
          <Kpi
            label="Overall pass rate"
            value={overallPassRate != null ? `${overallPassRate}%` : "-"}
            hint={`${mix.passed} passed / ${mix.failed} failed`}
            accent
          />
          <Kpi
            label="Automation coverage"
            value={`${cov?.coveragePct ?? 0}%`}
            hint={`${cov?.automated ?? 0}/${cov?.totalActive ?? 0} active cases`}
          />
          <Kpi
            label="Flaky cases"
            value={detailsLoading ? "…" : flaky.length}
            hint="inconsistent across runs"
          />
        </div>

        {/* Pass rate over time */}
        <Card
          title="Pass rate over time"
          subtitle="One bar per run, oldest to newest. Height is the run's pass rate."
        >
          <PassRateTimeline points={timeline} onOpen={openRun} />
        </Card>

        <div className="mt-4 grid grid-cols-[1.4fr_1fr] gap-4">
          {/* Per-suite health */}
          <Card title="Suite health" subtitle="Automation coverage and recorded pass rate per suite">
            {suites.length === 0 ? (
              <p className="text-sm text-text-muted">No suites yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-muted">
                    <th className="py-1.5 font-medium">Suite</th>
                    <th className="w-16 py-1.5 text-right font-medium">Cases</th>
                    <th className="w-40 py-1.5 font-medium">Coverage</th>
                    <th className="w-24 py-1.5 text-right font-medium">Pass rate</th>
                  </tr>
                </thead>
                <tbody>
                  {suites.map((s) => (
                    <tr key={s.id} className="border-b border-border-subtle/60">
                      <td className="py-2 text-text-primary">{s.name}</td>
                      <td className="py-2 text-right font-mono text-xs text-text-muted">
                        {s.active}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <Meter pct={s.coverage} />
                          <span className="w-8 shrink-0 text-right font-mono text-[11px] text-text-muted">
                            {s.coverage}%
                          </span>
                        </div>
                      </td>
                      <td className="py-2 text-right font-mono text-xs">
                        {s.passRate == null ? (
                          <span className="text-text-muted">-</span>
                        ) : (
                          <span className={passRateTone(s.passRate)}>{s.passRate}%</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* Result mix */}
          <Card title="Result mix" subtitle="Every recorded result across all runs">
            <RunProgressBar progress={mix} className="h-2.5" />
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
              <MixRow color="bg-status-passed" label="Passed" value={mix.passed} total={mix.total} />
              <MixRow color="bg-status-failed" label="Failed" value={mix.failed} total={mix.total} />
              <MixRow color="bg-status-blocked" label="Blocked" value={mix.blocked} total={mix.total} />
              <MixRow color="bg-status-retest" label="Retest" value={mix.retest} total={mix.total} />
              <MixRow color="bg-status-skipped" label="Skipped" value={mix.skipped} total={mix.total} />
              <MixRow color="bg-bg-surface-2" label="Untested" value={mix.untested} total={mix.total} />
            </div>
          </Card>
        </div>

        {/* Flaky cases */}
        <div className="mt-4">
          <Card
            title="Flaky cases"
            subtitle="Cases whose results disagree across runs, or that needed more than one attempt"
          >
            {detailsLoading ? (
              <p className="text-sm text-text-muted">Analyzing run history…</p>
            ) : flaky.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-status-passed">
                <Activity size={14} /> No flaky cases detected. Results are
                consistent across runs.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {flaky.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openCase(c.id)}
                    className="flex items-center gap-3 rounded-control border border-border-subtle bg-bg-surface-2/40 px-3 py-2 text-left hover:border-border-strong"
                  >
                    <TriangleAlert size={14} className="shrink-0 text-status-drifted" />
                    <span className="font-mono text-xs text-brand-primary">{c.id}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                      {c.title}
                    </span>
                    {c.attempts > 1 && (
                      <span className="inline-flex items-center gap-1 rounded bg-bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-status-retest">
                        <Repeat size={9} /> {c.attempts} attempts
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-text-muted">
                      {c.passed}P / {c.failed}F over {c.runs} run{c.runs === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Header({ subtitle }: { subtitle?: string }) {
  return (
    <div className="border-b border-border-subtle px-8 py-5">
      <h1 className="text-lg font-semibold">Reports</h1>
      {subtitle && (
        <p className="mt-0.5 text-xs text-text-muted">
          Analytics across recorded runs for {subtitle}
        </p>
      )}
    </div>
  );
}

function PassRateTimeline({
  points,
  onOpen,
}: {
  points: {
    id: string;
    name: string;
    created: string | null;
    executed: number;
    passRate: number | null;
  }[];
  onOpen: (id: string) => void;
}) {
  if (points.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-text-muted">
        No executed runs yet.
      </div>
    );
  }
  return (
    <div className="relative h-56">
      {/* gridlines */}
      <div className="absolute inset-x-0 top-0 flex h-44 flex-col justify-between">
        {[100, 50, 0].map((g) => (
          <div key={g} className="flex items-center gap-2">
            <span className="w-7 shrink-0 text-right font-mono text-[10px] text-text-muted">
              {g}
            </span>
            <div className="h-px flex-1 bg-border-subtle/60" />
          </div>
        ))}
      </div>
      {/* bars */}
      <div className="absolute inset-x-0 top-0 flex h-44 items-end gap-2 pl-9">
        {points.map((p) => (
          <button
            key={p.id}
            onClick={() => onOpen(p.id)}
            title={`${p.name}\n${p.passRate ?? "not executed"}${
              p.passRate != null ? "% pass" : ""
            }${p.created ? ` · ${relativeTime(p.created)}` : ""}`}
            className="group flex min-w-0 flex-1 flex-col justify-end"
          >
            {p.passRate == null ? (
              <div className="w-full rounded-t bg-bg-surface-2" style={{ height: "2%" }} />
            ) : (
              <div
                className={cn("w-full rounded-t transition-opacity group-hover:opacity-80", passRateBar(p.passRate))}
                style={{ height: `${Math.max(p.passRate, 2)}%` }}
              />
            )}
          </button>
        ))}
      </div>
      {/* x labels */}
      <div className="absolute inset-x-0 bottom-0 flex h-10 gap-2 pl-9">
        {points.map((p) => (
          <div
            key={p.id}
            className="min-w-0 flex-1 truncate pt-1.5 text-center text-[10px] text-text-muted"
            title={p.name}
          >
            {p.name}
          </div>
        ))}
      </div>
    </div>
  );
}

function MixRow({
  color,
  label,
  value,
  total,
}: {
  color: string;
  label: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", color)} />
      <span className="flex-1 text-text-secondary">{label}</span>
      <span className="font-mono text-text-primary">{value}</span>
      <span className="w-9 text-right font-mono text-text-muted">{pct}%</span>
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
      <div className="mt-2 text-xs text-text-muted">{hint}</div>
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
        {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Meter({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-bg-surface-2">
      <div
        className={cn("h-full rounded-full", meterColor(pct))}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function meterColor(pct: number): string {
  return pct >= 90
    ? "bg-status-passed"
    : pct >= 75
      ? "bg-status-blocked"
      : "bg-status-failed";
}

function passRateBar(pct: number): string {
  return pct >= 90
    ? "bg-status-passed"
    : pct >= 60
      ? "bg-status-blocked"
      : "bg-status-failed";
}

function passRateTone(pct: number): string {
  return pct >= 90
    ? "text-status-passed"
    : pct >= 60
      ? "text-status-blocked"
      : "text-status-failed";
}
