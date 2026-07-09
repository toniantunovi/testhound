import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  GitMerge,
  Hash,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { CaseMerge, FieldMerge, Side } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

type Picks = Record<string, Side>;

const SIDE_LABEL: Record<Side, string> = {
  base: "Base",
  ours: "Ours",
  theirs: "Theirs",
};

/** The semantic 3-way merge workspace: field-level conflict resolution for
 *  case files, plus next_case_id collision fixes (docs/04-git-storage.md §4.6). */
export function MergeView() {
  const qc = useQueryClient();
  const { data: conflicts, isLoading } = useQuery({
    queryKey: ["conflicts"],
    queryFn: api.listConflicts,
  });
  const { data: collisions } = useQuery({
    queryKey: ["id-collisions"],
    queryFn: api.idCollisions,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["conflicts"] });
    qc.invalidateQueries({ queryKey: ["id-collisions"] });
    qc.invalidateQueries({ queryKey: ["git-status"] });
    qc.invalidateQueries({ queryKey: ["cases"] });
  };

  const nothing =
    !isLoading &&
    (conflicts?.cases.length ?? 0) === 0 &&
    (conflicts?.other.length ?? 0) === 0 &&
    (collisions?.length ?? 0) === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-border-subtle px-8 py-5">
        <GitMerge size={18} className="text-brand-primary" />
        <h1 className="text-lg font-semibold">Merge</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        {nothing && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-card border border-border-subtle bg-bg-surface">
              <ShieldCheck size={22} className="text-status-passed" />
            </div>
            <h2 className="mb-1.5 text-base font-medium">No conflicts</h2>
            <p className="max-w-md text-sm leading-relaxed text-text-secondary">
              Your test cases are in sync with the branch you merged. When a{" "}
              <span className="font-mono text-xs">git merge</span> or pull leaves
              a case file conflicted, TestHound shows a field-by-field resolver
              here instead of raw conflict markers.
            </p>
          </div>
        )}

        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          {collisions && collisions.length > 0 && (
            <CollisionsCard collisions={collisions} onDone={invalidate} />
          )}

          {conflicts?.cases.map((cm) => (
            <CaseMergeCard key={cm.path} merge={cm} onResolved={invalidate} />
          ))}

          {conflicts && conflicts.other.length > 0 && (
            <div className="rounded-card border border-border-subtle bg-bg-surface p-4">
              <h3 className="mb-2 text-sm font-medium">Other conflicts</h3>
              <p className="mb-3 text-xs text-text-secondary">
                These aren&apos;t TestHound case files. Resolve them with your
                usual Git tooling, then reload.
              </p>
              <ul className="flex flex-col gap-1">
                {conflicts.other.map((o) => (
                  <li
                    key={o.path}
                    className="font-mono text-xs text-text-secondary"
                  >
                    {o.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CollisionsCard({
  collisions,
  onDone,
}: {
  collisions: { id: string; paths: string[] }[];
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const renumber = useMutation({
    mutationFn: (path: string) => api.renumberCase(path),
    onSuccess: onDone,
    onError: (e) => setError(errMsg(e)),
  });

  return (
    <div className="rounded-card border border-status-drifted/30 bg-status-drifted/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Hash size={15} className="text-status-drifted" />
        <h3 className="text-sm font-medium">Case id collisions</h3>
      </div>
      <p className="mb-3 text-xs text-text-secondary">
        Two branches minted the same case id. Renumber one file to a fresh id;
        TestHound relinks its automation links and run results.
      </p>
      {error && <p className="mb-2 text-xs text-status-failed">{error}</p>}
      <div className="flex flex-col gap-3">
        {collisions.map((c) => (
          <div key={c.id} className="rounded-control border border-border-subtle bg-bg-base p-3">
            <div className="mb-2 font-mono text-xs font-medium text-status-drifted">
              {c.id}
            </div>
            <ul className="flex flex-col gap-1.5">
              {c.paths.map((p, i) => (
                <li key={p} className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-xs text-text-secondary">
                    {p}
                  </span>
                  {i === 0 ? (
                    <span className="shrink-0 text-[11px] text-text-muted">
                      keeps id
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={renumber.isPending}
                      onClick={() => renumber.mutate(p)}
                    >
                      Renumber
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function CaseMergeCard({
  merge,
  onResolved,
}: {
  merge: CaseMerge;
  onResolved: () => void;
}) {
  const [picks, setPicks] = useState<Picks>(() =>
    Object.fromEntries(merge.fields.map((f) => [f.key, f.suggested])),
  );
  const [error, setError] = useState<string | null>(null);

  const resolve = useMutation({
    mutationFn: () => api.resolveCaseConflict(merge.path, picks),
    onSuccess: onResolved,
    onError: (e) => setError(errMsg(e)),
  });
  const keep = useMutation({
    mutationFn: (side: Side) => api.resolveCaseKeep(merge.path, side),
    onSuccess: onResolved,
    onError: (e) => setError(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: () => api.resolveCaseDelete(merge.path),
    onSuccess: onResolved,
    onError: (e) => setError(errMsg(e)),
  });

  const unresolved = useMemo(
    () => merge.fields.filter((f) => f.conflict && !picks[f.key]).length,
    [merge.fields, picks],
  );

  return (
    <div className="overflow-hidden rounded-card border border-border-subtle bg-bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-text-muted">{merge.id}</span>
            <h3 className="truncate text-sm font-medium">{merge.title}</h3>
          </div>
          <p className="truncate font-mono text-[11px] text-text-muted">
            {merge.path}
          </p>
        </div>
        {merge.hasConflict ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-status-failed/25 bg-status-failed/10 px-1.5 py-0.5 text-xs font-medium text-status-failed">
            <TriangleAlert size={11} /> Conflict
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-status-drifted/25 bg-status-drifted/10 px-1.5 py-0.5 text-xs font-medium text-status-drifted">
            Auto-mergeable
          </span>
        )}
      </div>

      {error && (
        <p className="border-b border-border-subtle bg-status-failed/5 px-4 py-2 text-xs text-status-failed">
          {error}
        </p>
      )}

      {merge.deletedSide ? (
        <div className="p-4">
          <p className="mb-3 text-sm text-text-secondary">
            One side deleted this case while the other changed it. Keep the
            edited version, or accept the deletion.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={keep.isPending}
              onClick={() =>
                keep.mutate(merge.deletedSide === "ours" ? "theirs" : "ours")
              }
            >
              Keep the edited case
            </Button>
            <Button
              variant="danger"
              disabled={del.isPending}
              onClick={() => del.mutate()}
            >
              Accept deletion
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="divide-y divide-border-subtle/60">
            {merge.fields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                selected={picks[f.key]}
                onSelect={(side) =>
                  setPicks((p) => ({ ...p, [f.key]: side }))
                }
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
            <span className="text-xs text-text-muted">
              {unresolved > 0
                ? `${unresolved} field(s) still need a pick`
                : "All fields resolved"}
            </span>
            <Button
              variant="primary"
              disabled={resolve.isPending || unresolved > 0}
              onClick={() => resolve.mutate()}
            >
              <Check size={13} /> Resolve case
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function FieldRow({
  field,
  selected,
  onSelect,
}: {
  field: FieldMerge;
  selected: Side | undefined;
  onSelect: (side: Side) => void;
}) {
  const sides: { side: Side; value: string | null }[] = [
    { side: "base", value: field.base },
    { side: "ours", value: field.ours },
    { side: "theirs", value: field.theirs },
  ];
  return (
    <div
      className={cn(
        "px-4 py-3",
        field.conflict && "bg-status-failed/[0.03]",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-text-primary">
          {field.label}
        </span>
        {field.conflict && (
          <span className="text-[10px] font-medium uppercase tracking-wide text-status-failed">
            conflict
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {sides.map(({ side, value }) =>
          value === null && side === "base" ? null : (
            <SideCell
              key={side}
              side={side}
              value={value}
              active={selected === side}
              suggested={field.suggested === side}
              onClick={() => onSelect(side)}
            />
          ),
        )}
      </div>
    </div>
  );
}

function SideCell({
  side,
  value,
  active,
  suggested,
  onClick,
}: {
  side: Side;
  value: string | null;
  active: boolean;
  suggested: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col gap-1 rounded-control border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-brand-primary bg-brand-primary/10"
          : "border-border-subtle bg-bg-base hover:border-border-strong",
      )}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-text-muted">
        <span>{SIDE_LABEL[side]}</span>
        {suggested && <span className="text-brand-accent">suggested</span>}
      </span>
      <span className="whitespace-pre-wrap break-words text-xs text-text-secondary">
        {value === null || value === "" ? (
          <span className="italic text-text-muted">(empty)</span>
        ) : (
          value
        )}
      </span>
    </button>
  );
}
