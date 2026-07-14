import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderInput,
  Filter,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { CaseSummary, Priority, SuiteTree } from "@/lib/types";
import { useSession } from "@/store/session";
import { cn, initials, relativeTime } from "@/lib/utils";
import { AutomationBadge, PriorityBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];

export function Cases() {
  const selectedSuite = useSession((s) => s.selectedSuite);
  const selectedSection = useSession((s) => s.selectedSection);
  const selectSuite = useSession((s) => s.selectSuite);
  const openCase = useSession((s) => s.openCase);
  const qc = useQueryClient();

  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  /** Case shown in the preview panel on the right (single click). */
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data: suites = [] } = useQuery({
    queryKey: ["suites"],
    queryFn: api.listSuites,
  });
  const { data: cases = [] } = useQuery({
    queryKey: ["cases"],
    queryFn: api.listCases,
  });

  const invalidateCases = () => {
    ["cases", "suites", "coverage", "dashboard", "git-status"].forEach((k) =>
      qc.invalidateQueries({ queryKey: [k] }),
    );
  };

  const createCase = useMutation({
    mutationFn: () =>
      api.createCase(
        selectedSuite === "all" ? suites[0]?.id ?? "checkout" : selectedSuite,
        "New test case",
      ),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["suites"] });
      openCase(created.id);
    },
  });

  const deleteCase = useMutation({
    mutationFn: (id: string) => api.deleteCase(id),
    onSuccess: (_data, id) => {
      if (previewId === id) setPreviewId(null);
      invalidateCases();
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const duplicateCase = useMutation({
    mutationFn: (id: string) => api.duplicateCase(id),
    onSuccess: (copy) => {
      invalidateCases();
      setPreviewId(copy.id);
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const moveCase = useMutation({
    mutationFn: ({ id, suite }: { id: string; suite: string }) =>
      api.moveCase(id, suite),
    onSuccess: invalidateCases,
    onError: (e) => window.alert(errMsg(e)),
  });

  const createSuite = useMutation({
    mutationFn: (name: string) => api.createSuite(name),
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      selectSuite(id, null);
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const renameSuite = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.renameSuite(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const deleteSuite = useMutation({
    mutationFn: (id: string) => api.deleteSuite(id),
    onSuccess: (_data, id) => {
      if (selectedSuite === id) selectSuite("all", null);
      setPreviewId(null);
      invalidateCases();
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const confirmDeleteSuite = async (s: SuiteTree) => {
    const ok = await ask(
      `Delete suite "${s.name}" and its ${s.caseCount} case${
        s.caseCount === 1 ? "" : "s"
      }?\n\nThe files are removed from the working tree; review and commit the deletion in the Changes panel.`,
      { title: "Delete suite", kind: "warning" },
    );
    if (ok) deleteSuite.mutate(s.id);
  };

  const confirmDeleteCase = async (c: CaseSummary) => {
    const ok = await ask(
      `Delete ${c.id} "${c.title}"?\n\nThe file is removed from the working tree; review and commit the deletion in the Changes panel.`,
      { title: "Delete case", kind: "warning" },
    );
    if (ok) deleteCase.mutate(c.id);
  };

  const filtered = useMemo(() => {
    return cases.filter((c) => {
      if (selectedSuite !== "all" && c.suite !== selectedSuite) return false;
      if (selectedSection && c.section !== selectedSection) return false;
      if (priorityFilter !== "all" && c.priority !== priorityFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !c.title.toLowerCase().includes(q) &&
          !c.id.toLowerCase().includes(q) &&
          !c.tags.some((t) => t.toLowerCase().includes(q))
        )
          return false;
      }
      return true;
    });
  }, [cases, selectedSuite, selectedSection, query, priorityFilter]);

  const automated = filtered.filter(
    (c) => c.automationState === "linked" || c.automationState === "drifted",
  ).length;
  const drifted = filtered.filter((c) => c.automationState === "drifted").length;

  const heading =
    selectedSuite === "all"
      ? "All cases"
      : (() => {
          const s = suites.find((x) => x.id === selectedSuite);
          const sec = s?.sections.find((x) => x.id === selectedSection);
          return sec ? `${s?.name} / ${sec.name}` : s?.name ?? selectedSuite;
        })();

  return (
    <div className="flex h-full">
      <SuiteTreeNav
        suites={suites}
        totalCount={cases.length}
        selectedSuite={selectedSuite}
        selectedSection={selectedSection}
        onSelect={selectSuite}
        onCreateSuite={(name) => createSuite.mutate(name)}
        onRenameSuite={(id, name) => renameSuite.mutate({ id, name })}
        onDeleteSuite={confirmDeleteSuite}
        creating={createSuite.isPending}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header + toolbar */}
        <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{heading}</h1>
            <p className="mt-0.5 text-xs text-text-muted">
              {filtered.length} cases · {automated} automated · {drifted} drifted
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-8 items-center gap-2 rounded-control border border-border-subtle bg-bg-surface px-2.5">
              <Search size={13} className="text-text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search cases"
                className="w-40 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </div>
            <Button variant="secondary" size="md">
              <Filter size={13} /> Filters
            </Button>
            <PriorityFilter value={priorityFilter} onChange={setPriorityFilter} />
            <Button
              variant="primary"
              size="md"
              onClick={() => createCase.mutate()}
              disabled={createCase.isPending}
            >
              <Plus size={14} /> New case
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              No cases match. Create one with “New case”.
            </div>
          ) : (
            <CaseTable
              cases={filtered}
              suites={suites}
              selectedId={previewId}
              onSelect={(id) => setPreviewId(id)}
              onOpen={(id) => openCase(id)}
              onDuplicate={(c) => duplicateCase.mutate(c.id)}
              onMove={(c, suite) => moveCase.mutate({ id: c.id, suite })}
              onDelete={confirmDeleteCase}
            />
          )}
        </div>
      </div>

      {previewId && (
        <CasePreview
          id={previewId}
          onClose={() => setPreviewId(null)}
          onOpen={() => openCase(previewId)}
        />
      )}
    </div>
  );
}

function PriorityFilter({
  value,
  onChange,
}: {
  value: Priority | "all";
  onChange: (v: Priority | "all") => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value === "all" ? "Priority" : value;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-control border px-3 text-sm capitalize",
          value === "all"
            ? "border-border-strong bg-bg-surface-2 text-text-primary"
            : "border-brand-primary/40 bg-brand-primary/10 text-brand-primary",
        )}
      >
        {label}
        <ChevronDown size={13} className="opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
            {(["all", ...PRIORITIES] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm capitalize text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary"
              >
                <span className="w-3">
                  {p === value && <Check size={12} className="text-brand-primary" />}
                </span>
                {p === "all" ? "All priorities" : p}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Suite tree ----------------------------------------------------------------

function SuiteTreeNav({
  suites,
  totalCount,
  selectedSuite,
  selectedSection,
  onSelect,
  onCreateSuite,
  onRenameSuite,
  onDeleteSuite,
  creating,
}: {
  suites: SuiteTree[];
  totalCount: number;
  selectedSuite: string;
  selectedSection: string | null;
  onSelect: (suite: string, section?: string | null) => void;
  onCreateSuite: (name: string) => void;
  onRenameSuite: (id: string, name: string) => void;
  onDeleteSuite: (s: SuiteTree) => void;
  creating: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-bg-surface/50">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
          Suites
        </span>
        <button
          onClick={() => setAdding(true)}
          disabled={creating}
          title="New suite"
          className="text-text-muted hover:text-text-primary disabled:opacity-40"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-2 pb-2">
        <TreeRow
          label="All cases"
          count={totalCount}
          active={selectedSuite === "all"}
          onClick={() => onSelect("all", null)}
        />
        {suites.map((s) => (
          <div key={s.id}>
            {renamingId === s.id ? (
              <InlineNameInput
                initial={s.name}
                placeholder="Suite name"
                onSubmit={(name) => {
                  setRenamingId(null);
                  if (name && name !== s.name) onRenameSuite(s.id, name);
                }}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <TreeRow
                label={s.name}
                count={s.caseCount}
                active={selectedSuite === s.id && !selectedSection}
                hasChildren={s.sections.length > 0}
                onClick={() => onSelect(s.id, null)}
                menu={
                  <SuiteMenu
                    onRename={() => setRenamingId(s.id)}
                    onDelete={() => onDeleteSuite(s)}
                  />
                }
              />
            )}
            {selectedSuite === s.id &&
              s.sections.map((sec) => (
                <TreeRow
                  key={sec.id}
                  label={sec.name}
                  indent
                  active={selectedSection === sec.id}
                  onClick={() => onSelect(s.id, sec.id)}
                />
              ))}
          </div>
        ))}
        {adding && (
          <InlineNameInput
            placeholder="New suite name"
            onSubmit={(name) => {
              setAdding(false);
              if (name) onCreateSuite(name);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </aside>
  );
}

/** Text input used inline in the tree for creating and renaming suites.
 *  (window.prompt is a silent no-op inside the Tauri webview.) */
function InlineNameInput({
  initial = "",
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <div className="my-0.5 px-1">
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(value.trim());
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          const v = value.trim();
          if (v && v !== initial) onSubmit(v);
          else onCancel();
        }}
        className="h-7 w-full rounded-control border border-brand-primary/50 bg-bg-base px-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
      />
    </div>
  );
}

function SuiteMenu({
  onRename,
  onDelete,
}: {
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Suite actions"
        className={cn(
          "rounded-control p-0.5 text-text-muted transition-opacity hover:bg-bg-surface-2 hover:text-text-primary",
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
            <MenuItem
              icon={<Pencil size={13} />}
              label="Rename"
              onClick={() => {
                setOpen(false);
                onRename();
              }}
            />
            <MenuItem
              icon={<Trash2 size={13} />}
              label="Delete"
              danger
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
        danger
          ? "text-status-failed hover:bg-status-failed/10"
          : "text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function TreeRow({
  label,
  count,
  active,
  indent,
  hasChildren,
  onClick,
  menu,
}: {
  label: string;
  count?: number;
  active?: boolean;
  indent?: boolean;
  hasChildren?: boolean;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-1 rounded-control py-1.5 pr-2 text-sm transition-colors",
        indent ? "pl-7" : "pl-2",
        active
          ? "bg-bg-surface-2 text-text-primary"
          : "text-text-secondary hover:bg-bg-surface-2/50 hover:text-text-primary",
      )}
    >
      {hasChildren ? (
        <ChevronRight size={13} className="text-text-muted" />
      ) : (
        !indent && <span className="w-[13px]" />
      )}
      <span className="flex-1 truncate text-left">{label}</span>
      {menu}
      {count !== undefined && (
        <span className="font-mono text-xs text-text-muted">{count}</span>
      )}
    </div>
  );
}

// ---- Case table ------------------------------------------------------------------

function CaseTable({
  cases,
  suites,
  selectedId,
  onSelect,
  onOpen,
  onDuplicate,
  onMove,
  onDelete,
}: {
  cases: CaseSummary[];
  suites: SuiteTree[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onDuplicate: (c: CaseSummary) => void;
  onMove: (c: CaseSummary, suite: string) => void;
  onDelete: (c: CaseSummary) => void;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky top-0 z-10 bg-bg-base">
        <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-muted">
          <Th className="w-10 pl-6">
            <input type="checkbox" className="accent-brand-primary" />
          </Th>
          <Th className="w-24">ID</Th>
          <Th>Title</Th>
          <Th className="w-28">Priority</Th>
          <Th className="w-28">Type</Th>
          <Th className="w-36">Automation</Th>
          <Th className="w-20">Owner</Th>
          <Th className="w-20">Updated</Th>
          <Th className="w-10 pr-6" />
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => (
          <tr
            key={c.id}
            onClick={() => onSelect(c.id)}
            onDoubleClick={() => onOpen(c.id)}
            className={cn(
              "group cursor-pointer border-b border-border-subtle/60",
              selectedId === c.id
                ? "bg-bg-surface-2/60"
                : "hover:bg-bg-surface/60",
            )}
          >
            <td className="pl-6" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" className="accent-brand-primary" />
            </td>
            <td className="py-2 font-mono text-xs text-brand-primary">{c.id}</td>
            <td className="py-2 pr-4 text-text-primary">{c.title}</td>
            <td className="py-2">
              <PriorityBadge priority={c.priority} />
            </td>
            <td className="py-2 text-text-secondary">{c.type}</td>
            <td className="py-2">
              <AutomationBadge state={c.automationState} />
            </td>
            <td className="py-2">
              <span
                title={c.owner ?? undefined}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-bg-surface-2 font-mono text-[10px] text-text-secondary"
              >
                {initials(c.owner)}
              </span>
            </td>
            <td className="py-2 text-xs text-text-muted">
              {relativeTime(c.updated)}
            </td>
            <td className="py-2 pr-6" onClick={(e) => e.stopPropagation()}>
              <CaseRowMenu
                c={c}
                suites={suites}
                onOpen={() => onOpen(c.id)}
                onDuplicate={() => onDuplicate(c)}
                onMove={(suite) => onMove(c, suite)}
                onDelete={() => onDelete(c)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CaseRowMenu({
  c,
  suites,
  onOpen,
  onDuplicate,
  onMove,
  onDelete,
}: {
  c: CaseSummary;
  suites: SuiteTree[];
  onOpen: () => void;
  onDuplicate: () => void;
  onMove: (suite: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const targets = suites.filter((s) => s.id !== c.suite);

  const close = () => {
    setOpen(false);
    setMoving(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Actions for ${c.id}`}
        className={cn(
          "rounded-control p-1 text-text-muted transition-opacity hover:bg-bg-surface-2 hover:text-text-primary",
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
            {moving ? (
              <>
                <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  Move to suite
                </div>
                {targets.length === 0 && (
                  <div className="px-3 py-1.5 text-sm text-text-muted">
                    No other suites
                  </div>
                )}
                {targets.map((s) => (
                  <MenuItem
                    key={s.id}
                    label={s.name}
                    onClick={() => {
                      close();
                      onMove(s.id);
                    }}
                  />
                ))}
              </>
            ) : (
              <>
                <MenuItem
                  icon={<SquarePen size={13} />}
                  label="Open in editor"
                  onClick={() => {
                    close();
                    onOpen();
                  }}
                />
                <MenuItem
                  icon={<Copy size={13} />}
                  label="Duplicate"
                  onClick={() => {
                    close();
                    onDuplicate();
                  }}
                />
                <MenuItem
                  icon={<FolderInput size={13} />}
                  label="Move to suite…"
                  onClick={() => setMoving(true)}
                />
                <MenuItem
                  icon={<Trash2 size={13} />}
                  label="Delete"
                  danger
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Preview panel ---------------------------------------------------------------

/** Read-only detail panel shown on the right when a row is clicked. */
function CasePreview({
  id,
  onClose,
  onOpen,
}: {
  id: string;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { data: c, error } = useQuery({
    queryKey: ["case", id],
    queryFn: () => api.getCase(id),
  });

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-border-subtle bg-bg-surface/50">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <span className="font-mono text-xs text-brand-primary">{id}</span>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={onOpen}>
          <SquarePen size={13} /> Edit
        </Button>
        <button
          onClick={onClose}
          title="Close preview"
          className="rounded-control p-1 text-text-muted hover:bg-bg-surface-2 hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>

      {error ? (
        <div className="p-4 text-sm text-status-failed">{errMsg(error)}</div>
      ) : !c ? (
        <div className="p-4 text-sm text-text-muted">Loading…</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <h2 className="text-base font-semibold text-text-primary">{c.title}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PriorityBadge priority={c.priority} />
            <AutomationBadge state={c.automation.state} />
            <span className="text-xs capitalize text-text-secondary">{c.type}</span>
            <span className="text-xs capitalize text-text-muted">{c.status}</span>
          </div>

          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-text-muted">Suite</dt>
            <dd className="font-mono text-text-secondary">
              {c.suite}
              {c.section ? ` / ${c.section}` : ""}
            </dd>
            <dt className="text-text-muted">Owner</dt>
            <dd className="text-text-secondary">{c.owner || "unassigned"}</dd>
            {c.tags.length > 0 && (
              <>
                <dt className="text-text-muted">Tags</dt>
                <dd className="flex flex-wrap gap-1">
                  {c.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-control bg-bg-surface-2 px-1.5 py-0.5 font-mono text-text-secondary"
                    >
                      {t}
                    </span>
                  ))}
                </dd>
              </>
            )}
            {c.references.length > 0 && (
              <>
                <dt className="text-text-muted">Refs</dt>
                <dd className="flex flex-col gap-0.5">
                  {c.references.map((r) => (
                    <ReferenceLink key={r} value={r} />
                  ))}
                </dd>
              </>
            )}
          </dl>

          {c.preconditions.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Preconditions
              </h3>
              <ul className="list-disc space-y-0.5 pl-4 text-sm text-text-secondary">
                {c.preconditions.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-5">
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Steps
            </h3>
            {c.steps.length === 0 ? (
              <p className="text-sm text-text-muted">No steps.</p>
            ) : (
              <ol className="space-y-2">
                {c.steps.map((s) => (
                  <li key={s.number} className="flex gap-2 text-sm">
                    <span className="mt-px shrink-0 font-mono text-xs text-text-muted">
                      {s.number}.
                    </span>
                    <div className="min-w-0">
                      <div className="text-text-primary">{s.action}</div>
                      {s.expected && (
                        <div className="mt-0.5 text-xs text-text-secondary">
                          Expected: {s.expected}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}

/** A case reference: URLs open in the system browser, plain ids render as text. */
export function ReferenceLink({ value }: { value: string }) {
  const isUrl = /^https?:\/\//i.test(value);
  if (!isUrl) {
    return <span className="font-mono text-text-secondary">{value}</span>;
  }
  return (
    <button
      onClick={() => api.openUrl(value)}
      title={value}
      className="truncate text-left font-mono text-brand-primary underline decoration-border-strong decoration-dotted underline-offset-2 hover:decoration-brand-primary"
    >
      {value}
    </button>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <th className={cn("py-2 font-medium", className)}>{children}</th>;
}
