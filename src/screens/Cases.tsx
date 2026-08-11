import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderInput,
  FolderPlus,
  Filter,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { countBucket, track } from "@/lib/telemetry";
import type { CaseSummary, Priority, Section, SuiteTree } from "@/lib/types";
import {
  groupBySection,
  groupBySuite,
  matchesCase,
  nudgeIds,
  orderableIds,
  reorderIds,
  sortCases,
  type CaseGroup,
} from "@/lib/cases";
import { useSession } from "@/store/session";
import { cn, initials, relativeTime } from "@/lib/utils";
import { AutomationBadge, PriorityBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];

/** Drag payload for a case row: the case id. A custom type (rather than
 *  `text/plain`) lets drop targets accept case drags only, and lets the tree and
 *  the table share one drag without any state between them.
 *
 *  Dragging is an accelerator, never the only way: the row menu offers Move
 *  up/down and Move to suite or folder, because the webview's OS-level drag-drop
 *  handling (which the assistant panel needs for file drops) can swallow
 *  in-page HTML5 drags on some platforms. */
const CASE_MIME = "application/x-testhound-case";

const isCaseDrag = (e: React.DragEvent) =>
  e.dataTransfer.types.includes(CASE_MIME);

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
      void track("case_created", { count_bucket: countBucket(cases.length + 1) });
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

  /** Move a case into a suite/folder. `order`, when given, is the destination
   *  group's full sequence after the move, so a drag lands the case exactly
   *  where it was dropped instead of at the end. */
  const moveCase = useMutation({
    mutationFn: async ({
      id,
      suite,
      section,
      order,
    }: {
      id: string;
      suite: string;
      section: string | null;
      order?: string[];
    }) => {
      await api.moveCase(id, suite, section);
      if (order) await api.reorderCases(suite, section, order);
    },
    onSuccess: invalidateCases,
    onError: (e) => window.alert(errMsg(e)),
  });

  const reorderCases = useMutation({
    mutationFn: ({
      suite,
      section,
      ids,
    }: {
      suite: string;
      section: string | null;
      ids: string[];
    }) => api.reorderCases(suite, section, ids),
    onSuccess: invalidateCases,
    onError: (e) => window.alert(errMsg(e)),
  });

  const reorderSuites = useMutation({
    mutationFn: (ids: string[]) => api.reorderSuites(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const reorderSections = useMutation({
    mutationFn: ({ suite, ids }: { suite: string; ids: string[] }) =>
      api.reorderSections(suite, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const createSection = useMutation({
    mutationFn: ({ suite, name }: { suite: string; name: string }) =>
      api.createSection(suite, name),
    onSuccess: (id, { suite }) => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      selectSuite(suite, id);
    },
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

  const renameSection = useMutation({
    mutationFn: ({ suite, id, name }: { suite: string; id: string; name: string }) =>
      api.renameSection(suite, id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const deleteSection = useMutation({
    mutationFn: ({ suite, id }: { suite: string; id: string }) =>
      api.deleteSection(suite, id),
    onSuccess: (_data, { suite, id }) => {
      if (selectedSuite === suite && selectedSection === id)
        selectSuite(suite, null);
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

  const confirmDeleteSection = async (suite: string, section: Section) => {
    const ok = await ask(
      `Delete folder "${section.name}"?\n\nIts cases stay in the suite but lose their folder assignment. Review and commit the change in the Changes panel.`,
      { title: "Delete folder", kind: "warning" },
    );
    if (ok) deleteSection.mutate({ suite, id: section.id });
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
      return matchesCase(c, query);
    });
  }, [cases, selectedSuite, selectedSection, query, priorityFilter]);

  /** Rows in tree order: suite, then folder, then the manual per-case order. */
  const sorted = useMemo(() => sortCases(filtered, suites), [filtered, suites]);

  const activeSuite = suites.find((s) => s.id === selectedSuite);
  const activeSection =
    activeSuite?.sections.find((s) => s.id === selectedSection) ?? null;

  // Reordering is offered inside a single suite only, and only when nothing
  // narrows the rows: dropping a case between two visible rows has to mean the
  // same thing on disk, which it cannot when rows in between are filtered out.
  const reorderable =
    !!activeSuite && !query.trim() && priorityFilter === "all";

  const groups: CaseGroup[] = useMemo(() => {
    if (!activeSuite) return groupBySuite(sorted, suites);
    if (selectedSection)
      return [
        {
          key: selectedSection,
          // The folder can vanish underneath the selection (a branch switch, a
          // pull, an outside edit), so the id drives the drop target and only
          // the label falls back to it.
          label: activeSection?.name ?? selectedSection,
          sectionId: selectedSection,
          cases: sorted,
        },
      ];
    return groupBySection(sorted, activeSuite);
  }, [sorted, suites, activeSuite, activeSection, selectedSection]);

  /** The ids of every case sharing a case's suite and folder, in display order:
   *  the sequence a reorder has to send. Broken cases are left out; their front
   *  matter does not parse, so no order can be written into them. */
  const groupIdsFor = (c: CaseSummary) =>
    sorted
      .filter(
        (x) =>
          !x.broken &&
          x.suite === c.suite &&
          (x.section ?? null) === (c.section ?? null),
      )
      .map((x) => x.id);

  /** A case was dropped into `section` of the selected suite, at the position
   *  described by `ids`. Same group: a reorder. Different group: a move that
   *  also carries the new order. */
  const dropCaseInGroup = (
    caseId: string,
    section: string | null,
    ids: string[],
  ) => {
    const c = cases.find((x) => x.id === caseId);
    if (!c || !activeSuite) return;
    if (c.suite === activeSuite.id && (c.section ?? null) === section) {
      reorderCases.mutate({ suite: activeSuite.id, section, ids });
    } else {
      moveCase.mutate({ id: caseId, suite: activeSuite.id, section, order: ids });
    }
  };

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
        onRenameSection={(suite, id, name) =>
          renameSection.mutate({ suite, id, name })}
        onDeleteSection={confirmDeleteSection}
        onCreateSection={(suite, name) => createSection.mutate({ suite, name })}
        onReorderSuites={(ids) => reorderSuites.mutate(ids)}
        onReorderSections={(suite, ids) => reorderSections.mutate({ suite, ids })}
        onDropCase={(suite, section, caseId) =>
          moveCase.mutate({ id: caseId, suite, section })}
        creating={createSuite.isPending}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header + toolbar */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle px-6 py-4">
          <div className="min-w-[8rem] flex-1">
            <h1 className="truncate text-lg font-semibold">{heading}</h1>
            <p className="mt-0.5 text-xs text-text-muted">
              {filtered.length} cases · {automated} automated · {drifted} drifted
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex h-8 min-w-0 items-center gap-2 rounded-control border border-border-subtle bg-bg-surface px-2.5">
              <Search size={13} className="shrink-0 text-text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search cases or refs"
                className="w-full min-w-0 max-w-40 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
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
          {sorted.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              No cases match. Create one with “New case”.
            </div>
          ) : (
            <CaseTable
              groups={groups}
              suites={suites}
              showGroupHeaders={!selectedSection}
              reorderable={reorderable}
              selectedId={previewId}
              onSelect={(id) => setPreviewId(id)}
              onOpen={(id) => openCase(id)}
              onDuplicate={(c) => duplicateCase.mutate(c.id)}
              onMove={(c, suite, section) =>
                moveCase.mutate({ id: c.id, suite, section })}
              onDrop={dropCaseInGroup}
              onNudge={(c, delta) => {
                const ids = nudgeIds(groupIdsFor(c), c.id, delta);
                if (ids)
                  reorderCases.mutate({
                    suite: c.suite,
                    section: c.section ?? null,
                    ids,
                  });
              }}
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
  onRenameSection,
  onDeleteSection,
  onCreateSection,
  onReorderSuites,
  onReorderSections,
  onDropCase,
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
  onRenameSection: (suite: string, id: string, name: string) => void;
  onDeleteSection: (suite: string, section: Section) => void;
  onCreateSection: (suite: string, name: string) => void;
  onReorderSuites: (ids: string[]) => void;
  onReorderSections: (suite: string, ids: string[]) => void;
  onDropCase: (suite: string, section: string | null, caseId: string) => void;
  creating: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** Suite whose new folder is being named inline. */
  const [addingSection, setAddingSection] = useState<string | null>(null);
  /** Section being renamed inline, keyed `${suiteId}::${sectionId}`. */
  const [renamingSection, setRenamingSection] = useState<string | null>(null);
  /** Suite ids whose sections are expanded in the tree. */
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    new Set(selectedSuite !== "all" ? [selectedSuite] : []),
  );

  // Keep the selected suite expanded so its folders (and the active filter
  // context) stay visible when selection changes from elsewhere.
  useEffect(() => {
    if (selectedSuite === "all") return;
    setExpanded((prev) =>
      prev.has(selectedSuite) ? prev : new Set(prev).add(selectedSuite),
    );
  }, [selectedSuite]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const moveSuite = (id: string, delta: -1 | 1) => {
    const ids = nudgeIds(
      suites.map((s) => s.id),
      id,
      delta,
    );
    if (ids) onReorderSuites(ids);
  };

  const moveSection = (suite: SuiteTree, id: string, delta: -1 | 1) => {
    const ids = nudgeIds(
      suite.sections.map((s) => s.id),
      id,
      delta,
    );
    if (ids) onReorderSections(suite.id, ids);
  };

  const startSection = (suite: string) => {
    setExpanded((prev) => new Set(prev).add(suite));
    setAddingSection(suite);
  };

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-border-subtle bg-bg-surface/50 xl:w-60">
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
        {suites.map((s, si) => (
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
                expanded={expanded.has(s.id)}
                onToggle={() => toggle(s.id)}
                onClick={() => {
                  onSelect(s.id, null);
                  if (s.sections.length > 0) setExpanded((p) => new Set(p).add(s.id));
                }}
                onDropCase={(caseId) => onDropCase(s.id, null, caseId)}
                menu={
                  <RowMenu
                    title="Suite actions"
                    onRename={() => setRenamingId(s.id)}
                    onDelete={() => onDeleteSuite(s)}
                    onNewFolder={() => startSection(s.id)}
                    onMoveUp={si > 0 ? () => moveSuite(s.id, -1) : undefined}
                    onMoveDown={
                      si < suites.length - 1 ? () => moveSuite(s.id, 1) : undefined
                    }
                  />
                }
              />
            )}
            {expanded.has(s.id) &&
              s.sections.map((sec, ci) =>
                renamingSection === `${s.id}::${sec.id}` ? (
                  <div key={sec.id} className="pl-5">
                    <InlineNameInput
                      initial={sec.name}
                      placeholder="Folder name"
                      onSubmit={(name) => {
                        setRenamingSection(null);
                        if (name && name !== sec.name)
                          onRenameSection(s.id, sec.id, name);
                      }}
                      onCancel={() => setRenamingSection(null)}
                    />
                  </div>
                ) : (
                  <TreeRow
                    key={sec.id}
                    label={sec.name}
                    indent
                    active={selectedSuite === s.id && selectedSection === sec.id}
                    onClick={() => onSelect(s.id, sec.id)}
                    onDropCase={(caseId) => onDropCase(s.id, sec.id, caseId)}
                    menu={
                      <RowMenu
                        title="Folder actions"
                        onRename={() => setRenamingSection(`${s.id}::${sec.id}`)}
                        onDelete={() => onDeleteSection(s.id, sec)}
                        onMoveUp={ci > 0 ? () => moveSection(s, sec.id, -1) : undefined}
                        onMoveDown={
                          ci < s.sections.length - 1
                            ? () => moveSection(s, sec.id, 1)
                            : undefined
                        }
                      />
                    }
                  />
                ),
              )}
            {addingSection === s.id && (
              <div className="pl-5">
                <InlineNameInput
                  placeholder="New folder name"
                  onSubmit={(name) => {
                    setAddingSection(null);
                    if (name) onCreateSection(s.id, name);
                  }}
                  onCancel={() => setAddingSection(null)}
                />
              </div>
            )}
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

function RowMenu({
  title,
  onRename,
  onDelete,
  onNewFolder,
  onMoveUp,
  onMoveDown,
}: {
  title: string;
  onRename: () => void;
  onDelete: () => void;
  /** Only suites can hold folders, so only they pass this. */
  onNewFolder?: () => void;
  /** Omitted at the ends of the list, where there is nowhere to move. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
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
          <div className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
            {onNewFolder && (
              <MenuItem
                icon={<FolderPlus size={13} />}
                label="New folder"
                onClick={act(onNewFolder)}
              />
            )}
            <MenuItem
              icon={<Pencil size={13} />}
              label="Rename"
              onClick={act(onRename)}
            />
            {onMoveUp && (
              <MenuItem
                icon={<ArrowUp size={13} />}
                label="Move up"
                onClick={act(onMoveUp)}
              />
            )}
            {onMoveDown && (
              <MenuItem
                icon={<ArrowDown size={13} />}
                label="Move down"
                onClick={act(onMoveDown)}
              />
            )}
            <MenuItem
              icon={<Trash2 size={13} />}
              label="Delete"
              danger
              onClick={act(onDelete)}
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
  indent,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  danger?: boolean;
  /** A folder listed under its suite in the "Move to" list. */
  indent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm",
        indent ? "pl-7" : "pl-3",
        danger
          ? "text-status-failed hover:bg-status-failed/10"
          : "text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function TreeRow({
  label,
  count,
  active,
  indent,
  hasChildren,
  expanded,
  onToggle,
  onClick,
  onDropCase,
  menu,
}: {
  label: string;
  count?: number;
  active?: boolean;
  indent?: boolean;
  hasChildren?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onClick: () => void;
  /** Accept a case dragged from the table: files it into this suite/folder. */
  onDropCase?: (caseId: string) => void;
  menu?: React.ReactNode;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      onDragOver={
        onDropCase
          ? (e) => {
              if (!isCaseDrag(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(true);
            }
          : undefined
      }
      onDragLeave={onDropCase ? () => setDropTarget(false) : undefined}
      onDrop={
        onDropCase
          ? (e) => {
              if (!isCaseDrag(e)) return;
              e.preventDefault();
              setDropTarget(false);
              const id = e.dataTransfer.getData(CASE_MIME);
              if (id) onDropCase(id);
            }
          : undefined
      }
      className={cn(
        "group flex w-full cursor-pointer items-center gap-1 rounded-control py-1.5 pr-2 text-sm transition-colors",
        indent ? "pl-7" : "pl-2",
        active
          ? "bg-bg-surface-2 text-text-primary"
          : "text-text-secondary hover:bg-bg-surface-2/50 hover:text-text-primary",
        dropTarget && "ring-1 ring-brand-primary",
      )}
    >
      {hasChildren ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          title={expanded ? "Collapse" : "Expand"}
          className="-m-0.5 rounded-control p-0.5 text-text-muted hover:text-text-primary"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
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
  groups,
  suites,
  showGroupHeaders,
  reorderable,
  selectedId,
  onSelect,
  onOpen,
  onDuplicate,
  onMove,
  onDrop,
  onNudge,
  onDelete,
}: {
  groups: CaseGroup[];
  suites: SuiteTree[];
  /** Show a header per group: folder names inside a suite, suite names in the
   *  "All cases" view, which is ordered by suite. */
  showGroupHeaders: boolean;
  /** Whether dropping between rows can be honored: see `reorderable` in Cases. */
  reorderable: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onDuplicate: (c: CaseSummary) => void;
  onMove: (c: CaseSummary, suite: string, section: string | null) => void;
  /** A case was dropped into `section`; `ids` is that group's new full order. */
  onDrop: (caseId: string, section: string | null, ids: string[]) => void;
  onNudge: (c: CaseSummary, delta: -1 | 1) => void;
  onDelete: (c: CaseSummary) => void;
}) {
  const openAutomation = useSession((s) => s.openAutomation);
  /** The case being dragged, so its row can be dimmed. */
  const [dragId, setDragId] = useState<string | null>(null);
  /** Row the pointer is over mid-drag, and the edge it would land on. */
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  /** Folder header the pointer is over mid-drag (drops at the end of it). */
  const [overGroup, setOverGroup] = useState<string | null>(null);

  const headers = showGroupHeaders && groups.length > 1;
  const columns = 11;

  const acceptRow = (e: React.DragEvent, id: string) => {
    // The drag payload is unreadable until the drop, so the row being dragged is
    // recognized by state instead: no insertion marker on itself.
    if (!reorderable || !isCaseDrag(e) || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = e.currentTarget.getBoundingClientRect();
    setOverGroup(null);
    setOver({ id, after: e.clientY > box.top + box.height / 2 });
  };

  const dropOnRow = (e: React.DragEvent, group: CaseGroup, id: string) => {
    if (!reorderable || !isCaseDrag(e)) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    setOver(null);
    const dragged = e.dataTransfer.getData(CASE_MIME);
    if (!dragged || dragged === id) return;
    onDrop(
      dragged,
      group.sectionId,
      reorderIds(orderableIds(group), dragged, id, after),
    );
  };

  const dropOnGroup = (e: React.DragEvent, group: CaseGroup) => {
    if (!isCaseDrag(e)) return;
    e.preventDefault();
    setOverGroup(null);
    const dragged = e.dataTransfer.getData(CASE_MIME);
    if (!dragged) return;
    const ids = orderableIds(group).filter((id) => id !== dragged);
    onDrop(dragged, group.sectionId, [...ids, dragged]);
  };

  return (
    <table className="w-full min-w-[960px] border-collapse text-sm">
      <thead className="sticky top-0 z-10 bg-bg-base">
        <tr className="whitespace-nowrap border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-muted">
          <Th className="w-7 pl-4" />
          <Th className="w-10 pl-1">
            <input type="checkbox" className="accent-brand-primary" />
          </Th>
          <Th className="w-24">ID</Th>
          <Th>Title</Th>
          <Th className="w-32">Refs</Th>
          <Th className="w-28">Priority</Th>
          <Th className="w-28">Type</Th>
          <Th className="w-36">Automation</Th>
          <Th className="w-20">Owner</Th>
          <Th className="w-20">Updated</Th>
          <Th className="w-10 pr-6" />
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {headers && (
              <tr
                // Dropping on a header files the case at the end of that group.
                // Only meaningful while reordering is possible: outside a single
                // suite there is no group to reorder within.
                onDragOver={(e) => {
                  if (!reorderable || !isCaseDrag(e)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOver(null);
                  setOverGroup(group.key);
                }}
                onDragLeave={() => setOverGroup(null)}
                onDrop={(e) => reorderable && dropOnGroup(e, group)}
                className={cn(
                  "border-b border-border-subtle/60 bg-bg-surface/40",
                  overGroup === group.key && "ring-1 ring-inset ring-brand-primary",
                )}
              >
                <td colSpan={columns} className="px-6 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                      {group.label}
                    </span>
                    <span className="font-mono text-[11px] text-text-muted">
                      {group.cases.length}
                    </span>
                  </div>
                </td>
              </tr>
            )}
            {group.cases.map((c) => (
              <tr
                key={c.id}
                onClick={() => onSelect(c.id)}
                onDoubleClick={() => onOpen(c.id)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(CASE_MIME, c.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragId(c.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOver(null);
                  setOverGroup(null);
                }}
                onDragOver={(e) => acceptRow(e, c.id)}
                onDragLeave={() =>
                  setOver((o) => (o?.id === c.id ? null : o))}
                onDrop={(e) => dropOnRow(e, group, c.id)}
                className={cn(
                  "group cursor-pointer whitespace-nowrap border-b border-border-subtle/60",
                  selectedId === c.id
                    ? "bg-bg-surface-2/60"
                    : "hover:bg-bg-surface/60",
                  dragId === c.id && "opacity-40",
                  over?.id === c.id &&
                    (over.after
                      ? "border-b-2 border-b-brand-primary"
                      : "border-t-2 border-t-brand-primary"),
                )}
              >
                <td className="pl-4 text-text-muted">
                  <span
                    title={
                      reorderable
                        ? "Drag to reorder, or onto a folder in the sidebar"
                        : "Drag onto a suite or folder in the sidebar to file it"
                    }
                    className="inline-flex cursor-grab opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <GripVertical size={13} />
                  </span>
                </td>
                <td className="pl-1" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" className="accent-brand-primary" />
                </td>
                <td className="py-2 font-mono text-xs text-brand-primary">{c.id}</td>
                <td className="py-2 pr-4 text-text-primary">
                  {c.broken ? (
                    <span
                      className="flex max-w-[32rem] items-center gap-1.5 text-status-failed"
                      title={`Front matter could not be parsed: ${c.path}. Open the file and fix the YAML.`}
                    >
                      <TriangleAlert size={13} className="shrink-0" />
                      <span className="truncate">{c.title}</span>
                    </span>
                  ) : (
                    <span className="block max-w-[32rem] truncate" title={c.title}>
                      {c.title}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <RefsCell references={c.references} />
                </td>
                <td className="py-2">
                  <PriorityBadge priority={c.priority} />
                </td>
                <td className="py-2 text-text-secondary">{c.type}</td>
                <td className="py-2">
                  <AutomationBadge
                    state={c.automationState}
                    onClick={() => openAutomation(c.id)}
                  />
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
                    reorderable={reorderable}
                    onOpen={() => onOpen(c.id)}
                    onDuplicate={() => onDuplicate(c)}
                    onMove={(suite, section) => onMove(c, suite, section)}
                    onNudge={(delta) => onNudge(c, delta)}
                    onDelete={() => onDelete(c)}
                  />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** The first reference plus a count of the rest: enough to recognize a case by
 *  its ticket while scanning, without turning the column into a list. */
function RefsCell({ references }: { references: string[] }) {
  if (references.length === 0) {
    return <span className="text-xs text-text-muted">-</span>;
  }
  // Prefer a ticket key over a URL: it is what people search for.
  const first =
    references.find((r) => !/^https?:\/\//i.test(r)) ?? references[0];
  const rest = references.length - 1;
  return (
    <span
      title={references.join("\n")}
      className="flex items-center gap-1 font-mono text-[11px] text-text-secondary"
    >
      <span className="truncate">{first}</span>
      {rest > 0 && <span className="shrink-0 text-text-muted">+{rest}</span>}
    </span>
  );
}

function CaseRowMenu({
  c,
  suites,
  reorderable,
  onOpen,
  onDuplicate,
  onMove,
  onNudge,
  onDelete,
}: {
  c: CaseSummary;
  suites: SuiteTree[];
  reorderable: boolean;
  onOpen: () => void;
  onDuplicate: () => void;
  onMove: (suite: string, section: string | null) => void;
  onNudge: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);

  const close = () => {
    setOpen(false);
    setMoving(false);
  };
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  const here = (suite: string, section: string | null) =>
    c.suite === suite && (c.section ?? null) === section;

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
          <div className="absolute right-0 top-full z-50 mt-1 max-h-72 w-52 overflow-auto rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
            {moving ? (
              <>
                <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  Move to
                </div>
                {suites.map((s) => (
                  <Fragment key={s.id}>
                    <MenuItem
                      label={s.name}
                      icon={
                        here(s.id, null) ? (
                          <Check size={12} className="text-brand-primary" />
                        ) : undefined
                      }
                      onClick={act(() => onMove(s.id, null))}
                    />
                    {s.sections.map((sec) => (
                      <MenuItem
                        key={sec.id}
                        label={sec.name}
                        indent
                        icon={
                          here(s.id, sec.id) ? (
                            <Check size={12} className="text-brand-primary" />
                          ) : undefined
                        }
                        onClick={act(() => onMove(s.id, sec.id))}
                      />
                    ))}
                  </Fragment>
                ))}
              </>
            ) : (
              <>
                <MenuItem
                  icon={<SquarePen size={13} />}
                  label="Open in editor"
                  onClick={act(onOpen)}
                />
                <MenuItem
                  icon={<Copy size={13} />}
                  label="Duplicate"
                  onClick={act(onDuplicate)}
                />
                {/* The same reordering as dragging, for anyone who would rather
                    not drag (and for when a filter rules dragging out). */}
                {reorderable && (
                  <>
                    <MenuItem
                      icon={<ArrowUp size={13} />}
                      label="Move up"
                      onClick={act(() => onNudge(-1))}
                    />
                    <MenuItem
                      icon={<ArrowDown size={13} />}
                      label="Move down"
                      onClick={act(() => onNudge(1))}
                    />
                  </>
                )}
                <MenuItem
                  icon={<FolderInput size={13} />}
                  label="Move to suite or folder…"
                  onClick={() => setMoving(true)}
                />
                <MenuItem
                  icon={<Trash2 size={13} />}
                  label="Delete"
                  danger
                  onClick={act(onDelete)}
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
  const openAutomation = useSession((s) => s.openAutomation);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border-subtle bg-bg-surface/50 xl:w-96">
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
            <AutomationBadge
              state={c.automation.state}
              onClick={() => openAutomation(c.id)}
            />
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
