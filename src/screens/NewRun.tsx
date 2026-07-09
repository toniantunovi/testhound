import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play } from "lucide-react";
import { api } from "@/lib/ipc";
import type { IncludeMode } from "@/lib/types";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import { PriorityBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const MODES: { id: IncludeMode; label: string; blurb: string }[] = [
  { id: "suite", label: "Whole suites", blurb: "Every case in the chosen suites" },
  { id: "filter", label: "Filter query", blurb: "Cases matching a saved query" },
  { id: "explicit", label: "Hand-picked", blurb: "A specific set of cases" },
];

export function NewRun() {
  const navigate = useSession((s) => s.navigate);
  const openRun = useSession((s) => s.openRun);
  const qc = useQueryClient();

  const [name, setName] = useState("New run");
  const [milestone, setMilestone] = useState<string>("");
  const [assignee, setAssignee] = useState("");
  const [description, setDescription] = useState("");
  const [config, setConfig] = useState<string[]>([]);
  const [mode, setMode] = useState<IncludeMode>("suite");
  const [query, setQuery] = useState("suite:checkout OR tag:p1");
  const [suites, setSuites] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);

  const { data: suiteTree = [] } = useQuery({
    queryKey: ["suites"],
    queryFn: api.listSuites,
  });
  const { data: milestones = [] } = useQuery({
    queryKey: ["milestones"],
    queryFn: api.listMilestones,
  });
  const { data: configurations = [] } = useQuery({
    queryKey: ["configurations"],
    queryFn: api.listConfigurations,
  });
  const { data: allCases = [] } = useQuery({
    queryKey: ["cases"],
    queryFn: api.listCases,
  });

  // Live resolution of the current definition to a preview set.
  const { data: preview = [], isFetching } = useQuery({
    queryKey: ["preview-run", mode, query, suites, picked],
    queryFn: () =>
      api.previewRun(
        mode,
        mode === "filter" ? query : null,
        mode === "suite" ? suites : [],
        mode === "explicit" ? picked : [],
      ),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createRun({
        name: name.trim() || "Untitled run",
        milestone: milestone || null,
        configuration: config,
        description: description.trim() || null,
        assignee: assignee.trim() || null,
        mode,
        query: mode === "filter" ? query : null,
        suites: mode === "suite" ? suites : [],
        cases: mode === "explicit" ? picked : [],
      }),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      openRun(run.id);
    },
  });

  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  const canCreate = preview.length > 0 && !create.isPending;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-3">
        <button
          onClick={() => navigate("runs")}
          className="text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-base font-semibold">New run</h1>
        <div className="flex-1" />
        <span className="text-xs text-text-muted">
          {isFetching ? "resolving…" : `${preview.length} cases`}
        </span>
        <Button
          variant="primary"
          size="md"
          disabled={!canCreate}
          onClick={() => create.mutate()}
        >
          <Play size={14} /> Create run
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Definition */}
        <div className="min-w-0 flex-1 overflow-auto px-8 py-6">
          <div className="mx-auto max-w-2xl">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-control border border-border-subtle bg-bg-base px-3 text-sm text-text-primary focus:border-border-strong focus:outline-none"
              />
            </Field>

            <Field label="Description">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="optional"
                className="h-9 w-full rounded-control border border-border-subtle bg-bg-base px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Milestone">
                <select
                  value={milestone}
                  onChange={(e) => setMilestone(e.target.value)}
                  className="h-9 w-full rounded-control border border-border-subtle bg-bg-base px-2 text-sm text-text-primary focus:border-border-strong focus:outline-none"
                >
                  <option value="">None</option>
                  {milestones.map((m) => (
                    <option key={m.id} value={m.id} className="bg-bg-surface">
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Assignee">
                <input
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  placeholder="unassigned"
                  className="h-9 w-full rounded-control border border-border-subtle bg-bg-base px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
                />
              </Field>
            </div>

            <Field label="Configuration">
              {configurations.length === 0 ? (
                <p className="text-xs text-text-muted">
                  No configurations defined.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {configurations.map((cfg) => (
                    <div key={cfg.id}>
                      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-text-muted">
                        {cfg.name}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {cfg.options.map((opt) => (
                          <Chip
                            key={opt.id}
                            active={config.includes(opt.id)}
                            onClick={() => toggle(config, setConfig, opt.id)}
                          >
                            {opt.name}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Field>

            <Field label="Include">
              <div className="grid grid-cols-3 gap-2">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    className={cn(
                      "rounded-card border px-3 py-2 text-left transition-colors",
                      mode === m.id
                        ? "border-brand-primary/50 bg-brand-primary/10"
                        : "border-border-subtle bg-bg-surface hover:bg-bg-surface-2/60",
                    )}
                  >
                    <div className="text-sm text-text-primary">{m.label}</div>
                    <div className="mt-0.5 text-[11px] leading-tight text-text-muted">
                      {m.blurb}
                    </div>
                  </button>
                ))}
              </div>
            </Field>

            {mode === "suite" && (
              <Field label="Suites">
                <div className="flex flex-wrap gap-1.5">
                  {suiteTree.map((s) => (
                    <Chip
                      key={s.id}
                      active={suites.includes(s.id)}
                      onClick={() => toggle(suites, setSuites, s.id)}
                    >
                      {s.name}
                      <span className="ml-1 font-mono text-[10px] text-text-muted">
                        {s.caseCount}
                      </span>
                    </Chip>
                  ))}
                </div>
              </Field>
            )}

            {mode === "filter" && (
              <Field label="Query">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  spellCheck={false}
                  className="h-9 w-full rounded-control border border-border-subtle bg-bg-base px-3 font-mono text-[13px] text-text-primary focus:border-border-strong focus:outline-none"
                />
                <p className="mt-1.5 text-xs text-text-muted">
                  Terms like{" "}
                  <code className="text-text-secondary">suite:checkout</code>,{" "}
                  <code className="text-text-secondary">tag:p1</code>,{" "}
                  <code className="text-text-secondary">priority:high</code>,
                  joined by <code className="text-text-secondary">AND</code> /{" "}
                  <code className="text-text-secondary">OR</code>.
                </p>
              </Field>
            )}

            {mode === "explicit" && (
              <Field label={`Cases (${picked.length} selected)`}>
                <div className="max-h-72 overflow-auto rounded-card border border-border-subtle">
                  {allCases.map((c) => (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2.5 border-b border-border-subtle/60 px-3 py-1.5 last:border-0 hover:bg-bg-surface-2/50"
                    >
                      <input
                        type="checkbox"
                        checked={picked.includes(c.id)}
                        onChange={() => toggle(picked, setPicked, c.id)}
                        className="accent-brand-primary"
                      />
                      <span className="font-mono text-xs text-brand-primary">
                        {c.id}
                      </span>
                      <span className="flex-1 truncate text-sm text-text-primary">
                        {c.title}
                      </span>
                      <span className="font-mono text-[11px] text-text-muted">
                        {c.suite}
                      </span>
                    </label>
                  ))}
                </div>
              </Field>
            )}
          </div>
        </div>

        {/* Preview */}
        <aside className="w-80 shrink-0 overflow-auto border-l border-border-subtle bg-bg-surface/50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Included cases
            </span>
            <span className="font-mono text-xs text-text-secondary">
              {preview.length}
            </span>
          </div>
          {preview.length === 0 ? (
            <p className="text-sm text-text-muted">
              Nothing matches yet. Adjust the definition on the left.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {preview.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-bg-surface-2/50"
                >
                  <span className="font-mono text-[11px] text-brand-primary">
                    {c.id}
                  </span>
                  <span className="flex-1 truncate text-xs text-text-secondary">
                    {c.title}
                  </span>
                  <PriorityBadge priority={c.priority} />
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-control border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-brand-primary/50 bg-brand-primary/10 text-text-primary"
          : "border-border-subtle bg-bg-surface text-text-secondary hover:bg-bg-surface-2/60",
      )}
    >
      {children}
    </button>
  );
}
