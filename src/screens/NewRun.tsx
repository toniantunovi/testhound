import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Check, Play } from "lucide-react";
import { api, errMsg, type CreateRunInput } from "@/lib/ipc";
import { countBucket, track } from "@/lib/telemetry";
import type {
  CaseStatus,
  CaseType,
  IncludeMode,
  Priority,
  RunDetail,
} from "@/lib/types";
import {
  buildQuery,
  emptyFacets,
  facetCount,
  parseQuery,
  type FacetKey,
  type Facets,
} from "@/lib/query";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";
import { cn } from "@/lib/utils";
import { PriorityBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const MODES: { id: IncludeMode; label: string; blurb: string }[] = [
  { id: "suite", label: "Whole suites", blurb: "Every case in the chosen suites" },
  { id: "filter", label: "Filter", blurb: "Cases matching a filter, e.g. every regression case" },
  { id: "explicit", label: "Hand-picked", blurb: "A specific set of cases" },
];

const TYPES: CaseType[] = [
  "functional",
  "regression",
  "smoke",
  "e2e",
  "negative",
  "a11y",
  "perf",
];
const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];
const STATUSES: CaseStatus[] = ["draft", "active", "deprecated"];

/** How many tags the picker offers before the rest are left to the query box.
 *  The most-used ones first: a project's tag vocabulary has no natural bound,
 *  and a wall of chips is no easier to use than typing. */
const TAG_CHIPS = 12;

/** The run builder, in either of its two jobs: defining a new run, or editing
 *  one that already exists (`editRunId` in the session). Both are the same
 *  form, so a run is changed where it was built. */
export function NewRun() {
  const editRunId = useSession((s) => s.editRunId);
  const { data: editing } = useQuery({
    queryKey: ["run", editRunId],
    queryFn: () => api.getRun(editRunId!),
    enabled: !!editRunId,
  });

  if (editRunId && !editing) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        Loading run…
      </div>
    );
  }
  // Keyed by the run, so switching which run is edited re-seeds the form.
  return <RunBuilder key={editRunId ?? "new"} editing={editing ?? null} />;
}

function RunBuilder({ editing }: { editing: RunDetail | null }) {
  const existing = editing?.run ?? null;
  const navigate = useSession((s) => s.navigate);
  const openRun = useSession((s) => s.openRun);
  const qc = useQueryClient();

  const [name, setName] = useState(existing?.name ?? "New run");
  const [milestone, setMilestone] = useState<string>(existing?.milestone ?? "");
  const [assignee, setAssignee] = useState(existing?.assignee ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [config, setConfig] = useState<string[]>(existing?.configuration ?? []);
  const [mode, setMode] = useState<IncludeMode>(
    existing?.includes.mode ?? "suite",
  );
  const [suites, setSuites] = useState<string[]>(
    existing?.includes.suites ?? [],
  );
  const [picked, setPicked] = useState<string[]>(
    existing?.includes.mode === "explicit" ? existing.includes.cases ?? [] : [],
  );
  // Filter mode: ticked facets, or a hand-written query once the user asks to
  // edit one. The query is what the run stores either way (see `buildQuery`).
  // A run being edited starts from its stored query, in the box until the
  // project's suites and tags are known well enough to tick it into the picker.
  const [facets, setFacets] = useState<Facets>(emptyFacets);
  const [queryText, setQueryText] = useState(existing?.includes.query ?? "");
  const [handWritten, setHandWritten] = useState(!!existing?.includes.query);

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

  const query = handWritten ? queryText : buildQuery(facets);

  // The values each facet offers. Suites and tags come from the project, so a
  // parsed query can only tick what actually exists.
  const tagOptions = useMemo(() => {
    const uses = new Map<string, number>();
    for (const c of allCases) {
      for (const t of c.tags) uses.set(t, (uses.get(t) ?? 0) + 1);
    }
    return [...uses.entries()]
      // A tag holding a comma or a space cannot be written as a term: the comma
      // is the term's either-or and whitespace separates terms. Leaving such a
      // tag out beats generating a query that means something else.
      .filter(([tag]) => !/[\s,]/.test(tag))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }, [allCases]);
  const allowed: Record<FacetKey, readonly string[]> = useMemo(
    () => ({
      suite: suiteTree.map((s) => s.id),
      type: TYPES,
      priority: PRIORITIES,
      status: STATUSES,
      tag: tagOptions,
    }),
    [suiteTree, tagOptions],
  );
  // A hand-written query goes back to the picker only when the chips can say
  // exactly what it says; otherwise the box keeps it.
  const reopenable = handWritten ? parseQuery(queryText, allowed) : null;

  // An edited run's stored query moves into the picker as soon as the project's
  // suites and tags are loaded, so editing starts where building left off. Once
  // only, and never over a query the user has already touched.
  const stored = existing?.includes.query ?? "";
  const seeded = useRef(!stored);
  useEffect(() => {
    if (seeded.current) return;
    if (queryText !== stored) {
      seeded.current = true;
      return;
    }
    if (suiteTree.length === 0 || allCases.length === 0) return;
    seeded.current = true;
    const parsed = parseQuery(stored, allowed);
    if (parsed) {
      setFacets(parsed);
      setHandWritten(false);
    }
  }, [stored, queryText, suiteTree, allCases, allowed]);

  const toggleFacet = (key: FacetKey, value: string) =>
    setFacets((f) => ({
      ...f,
      [key]: f[key].includes(value)
        ? f[key].filter((v) => v !== value)
        : [...f[key], value],
    }));

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

  const input: CreateRunInput = {
    name: name.trim() || "Untitled run",
    milestone: milestone || null,
    configuration: config,
    description: description.trim() || null,
    assignee: assignee.trim() || null,
    mode,
    query: mode === "filter" ? query : null,
    suites: mode === "suite" ? suites : [],
    cases: mode === "explicit" ? picked : [],
  };

  // Whether the include definition itself changed, mirroring what the backend
  // decides in `update_run`: an unchanged definition keeps the run's membership
  // snapshot verbatim rather than re-resolving it against a case corpus that
  // has moved on since the run was created.
  const redefined =
    !existing ||
    existing.includes.mode !== input.mode ||
    (existing.includes.query ?? null) !== (input.query ?? null) ||
    !sameList(existing.includes.suites ?? [], input.suites) ||
    (input.mode === "explicit" &&
      !sameList(
        existing.includes.cases ?? [],
        [...new Set(input.cases)].sort(),
      ));

  // What saving would leave the run holding: the resolved preview when the
  // definition changed, the snapshot it already has when it did not.
  const members =
    existing && !redefined
      ? allCases.filter((c) => (existing.includes.cases ?? []).includes(c.id))
      : preview;
  // Recorded results that leave with the cases they belong to.
  const losing = redefined
    ? (editing?.rows ?? []).filter(
        (r) => r.status !== "untested" && !members.some((c) => c.id === r.case),
      )
    : [];

  const save = useMutation({
    mutationFn: () =>
      existing ? api.updateRun(existing.id, input) : api.createRun(input),
    onSuccess: (run) => {
      if (!existing) {
        void track("run_created", {
          case_count_bucket: countBucket(members.length),
        });
      }
      qc.invalidateQueries({ queryKey: ["run", run.id] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      openRun(run.id);
    },
    onError: (e) => useActivity.getState().push(`x ${errMsg(e)}`),
  });

  const toggle = (arr: string[], set: (v: string[]) => void, id: string) =>
    set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  const canSave = members.length > 0 && !save.isPending;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-3">
        <button
          onClick={() => (existing ? openRun(existing.id) : navigate("runs"))}
          title={existing ? "Back to the run" : "Back to the run list"}
          className="text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="min-w-0 truncate text-base font-semibold">
          {existing ? `Edit ${existing.name}` : "New run"}
        </h1>
        <div className="flex-1" />
        <span className="shrink-0 text-xs text-text-muted">
          {isFetching && redefined ? "resolving…" : `${members.length} cases`}
        </span>
        <Button
          variant="primary"
          size="md"
          disabled={!canSave}
          onClick={() => save.mutate()}
        >
          {existing ? (
            <>
              <Check size={14} /> Save changes
            </>
          ) : (
            <>
              <Play size={14} /> Create run
            </>
          )}
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
              <Field label="Filter">
                {handWritten ? (
                  <>
                    <input
                      value={queryText}
                      onChange={(e) => setQueryText(e.target.value)}
                      spellCheck={false}
                      className="h-9 w-full rounded-control border border-border-subtle bg-bg-base px-3 font-mono text-[13px] text-text-primary focus:border-border-strong focus:outline-none"
                    />
                    <div className="mt-1.5 flex items-start justify-between gap-3">
                      <p className="text-xs text-text-muted">
                        Terms like{" "}
                        <code className="text-text-secondary">suite:checkout</code>,{" "}
                        <code className="text-text-secondary">tag:p1</code>,{" "}
                        <code className="text-text-secondary">
                          type:regression,smoke
                        </code>{" "}
                        (either), joined by{" "}
                        <code className="text-text-secondary">AND</code> /{" "}
                        <code className="text-text-secondary">OR</code>.
                      </p>
                      <TextButton
                        disabled={
                          reopenable
                            ? undefined
                            : "This query says more than the picker can show"
                        }
                        onClick={() => {
                          if (reopenable) setFacets(reopenable);
                          setHandWritten(false);
                        }}
                      >
                        Back to picker
                      </TextButton>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-card border border-border-subtle bg-bg-surface px-3 py-1.5">
                      <FacetRow
                        label="Type"
                        options={TYPES.map((t) => ({ value: t, label: t }))}
                        active={facets.type}
                        onToggle={(v) => toggleFacet("type", v)}
                      />
                      <FacetRow
                        label="Suite"
                        // A ticked suite stays listed even if the project no
                        // longer has it (a branch switch away), so it can be
                        // un-ticked rather than filtering invisibly.
                        options={[
                          ...suiteTree.map((s) => ({
                            value: s.id,
                            label: s.name,
                          })),
                          ...facets.suite
                            .filter((id) => !suiteTree.some((s) => s.id === id))
                            .map((id) => ({ value: id, label: id })),
                        ]}
                        active={facets.suite}
                        onToggle={(v) => toggleFacet("suite", v)}
                      />
                      <FacetRow
                        label="Priority"
                        options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                        active={facets.priority}
                        onToggle={(v) => toggleFacet("priority", v)}
                      />
                      <FacetRow
                        label="Status"
                        options={STATUSES.map((st) => ({
                          value: st,
                          label: st,
                        }))}
                        active={facets.status}
                        onToggle={(v) => toggleFacet("status", v)}
                      />
                      <FacetRow
                        label="Tags"
                        // Ticked tags stay visible even past the cap, so a tag
                        // the picker did not offer can still be un-ticked.
                        options={[
                          ...new Set([
                            ...facets.tag,
                            ...tagOptions.slice(0, TAG_CHIPS),
                          ]),
                        ].map((t) => ({ value: t, label: t }))}
                        active={facets.tag}
                        onToggle={(v) => toggleFacet("tag", v)}
                      />
                    </div>
                    <div className="mt-1.5 flex items-start justify-between gap-3">
                      <p className="font-mono text-[11px] leading-5 text-text-muted">
                        {query || "no filter: every case"}
                      </p>
                      <TextButton
                        onClick={() => {
                          setQueryText(buildQuery(facets));
                          setHandWritten(true);
                        }}
                      >
                        Edit as query
                      </TextButton>
                    </div>
                    {facetCount(facets) > 0 && (
                      <p className="mt-1 text-xs text-text-muted">
                        Values in one row match either; the rows are combined.
                      </p>
                    )}
                  </>
                )}
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
        <aside className="w-64 shrink-0 overflow-auto border-l border-border-subtle bg-bg-surface/50 p-4 xl:w-80">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Included cases
            </span>
            <span className="font-mono text-xs text-text-secondary">
              {members.length}
            </span>
          </div>
          {existing && !redefined && (
            <p className="mb-3 text-xs leading-relaxed text-text-muted">
              The definition is unchanged, so the run keeps the cases it was
              built with.
            </p>
          )}
          {losing.length > 0 && (
            <p className="mb-3 flex gap-2 rounded-card border border-status-failed/40 bg-status-failed/10 px-2.5 py-2 text-xs leading-relaxed text-text-secondary">
              <AlertTriangle
                size={14}
                className="mt-0.5 shrink-0 text-status-failed"
              />
              <span>
                {losing.length} recorded{" "}
                {losing.length === 1 ? "result" : "results"} will be deleted:
                these cases leave the run.
              </span>
            </p>
          )}
          {members.length === 0 ? (
            <p className="text-sm text-text-muted">
              Nothing matches yet. Adjust the definition on the left.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {members.map((c) => (
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

/** Two id lists as the backend compares them: same length, same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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

/** One facet's values as chips. Ticking two in a row means either of them; the
 *  rows are ANDed with each other. */
function FacetRow({
  label,
  options,
  active,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  active: string[];
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex gap-3 border-b border-border-subtle/60 py-1.5 last:border-0">
      <span className="w-14 shrink-0 pt-1.5 text-[11px] uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5 py-0.5">
        {options.map((o) => (
          <Chip
            key={o.value}
            active={active.includes(o.value)}
            onClick={() => onToggle(o.value)}
          >
            <span className="capitalize">{o.label}</span>
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** A quiet inline action. `disabled` carries the reason, shown on hover. */
function TextButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled !== undefined}
      title={disabled}
      className={cn(
        "shrink-0 text-xs",
        disabled !== undefined
          ? "cursor-not-allowed text-text-muted/60"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      {children}
    </button>
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
