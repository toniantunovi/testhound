import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ask, message } from "@tauri-apps/plugin-dialog";
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
import {
  groupTarget,
  rowTarget,
  startCaseDrag,
  treeTarget,
  useCaseDrag,
  useDragPointer,
  type CaseDropTarget,
} from "@/lib/caseDrag";
import { useSession } from "@/store/session";
import { cn, initials, relativeTime } from "@/lib/utils";
import { AutomationBadge, PriorityBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];

/** Report a rejected write. Not `window.alert`, which this webview silently
 *  ignores: a refused move has to say so, all the more when it was a bulk one
 *  that may have moved some cases before it stopped. */
const reportError = (e: unknown) =>
  void message(errMsg(e), { title: "TestHound", kind: "error" });

// Dragging a case is an accelerator, never the only way: the row menu offers
// Move up/down and Move to suite or folder for anyone who would rather not drag,
// and for when a filter rules dragging out. The drag itself runs on pointer
// events rather than HTML5 drag and drop, for the reason in src/lib/caseDrag.ts.

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
  /** Cases ticked for a bulk move. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** The row a shift-click ranges from, with the selection as it stood when that
   *  row was ticked: a shift-click replaces its own previous range instead of
   *  piling a second one on top, so a range can be shrunk as well as grown. */
  const [anchor, setAnchor] = useState<{ id: string; base: Set<string> } | null>(
    null,
  );

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
    onError: reportError,
  });

  const duplicateCase = useMutation({
    mutationFn: (id: string) => api.duplicateCase(id),
    onSuccess: (copy) => {
      invalidateCases();
      setPreviewId(copy.id);
    },
    onError: reportError,
  });

  /** Move cases into a suite/folder, one write per case: the backend moves one
   *  file at a time, and a failure part-way should leave the cases before it
   *  moved rather than roll the lot back. `order`, when given, is the
   *  destination group's full sequence afterwards, so a drop lands them where
   *  they fell instead of at the end. */
  const moveCases = useMutation({
    mutationFn: async ({
      ids,
      suite,
      section,
      order,
    }: {
      ids: string[];
      suite: string;
      section: string | null;
      order?: string[];
    }) => {
      for (const id of ids) await api.moveCase(id, suite, section);
      if (order) await api.reorderCases(suite, section, order);
    },
    onSuccess: invalidateCases,
    onError: reportError,
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
    onError: reportError,
  });

  const reorderSuites = useMutation({
    mutationFn: (ids: string[]) => api.reorderSuites(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: reportError,
  });

  const reorderSections = useMutation({
    mutationFn: ({ suite, ids }: { suite: string; ids: string[] }) =>
      api.reorderSections(suite, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: reportError,
  });

  const createSection = useMutation({
    mutationFn: ({ suite, name }: { suite: string; name: string }) =>
      api.createSection(suite, name),
    onSuccess: (id, { suite }) => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      selectSuite(suite, id);
    },
    onError: reportError,
  });

  const createSuite = useMutation({
    mutationFn: (name: string) => api.createSuite(name),
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      selectSuite(id, null);
    },
    onError: reportError,
  });

  const renameSuite = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.renameSuite(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: reportError,
  });

  const deleteSuite = useMutation({
    mutationFn: (id: string) => api.deleteSuite(id),
    onSuccess: (_data, id) => {
      if (selectedSuite === id) selectSuite("all", null);
      setPreviewId(null);
      invalidateCases();
    },
    onError: reportError,
  });

  const renameSection = useMutation({
    mutationFn: ({ suite, id, name }: { suite: string; id: string; name: string }) =>
      api.renameSection(suite, id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suites"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: reportError,
  });

  const deleteSection = useMutation({
    mutationFn: ({ suite, id }: { suite: string; id: string }) =>
      api.deleteSection(suite, id),
    onSuccess: (_data, { suite, id }) => {
      if (selectedSuite === suite && selectedSection === id)
        selectSuite(suite, null);
      invalidateCases();
    },
    onError: reportError,
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

  /** The rows that can be ticked, in the order they are shown: what "select all"
   *  covers, what a shift-click ranges over, and the order a multi-case drag
   *  keeps. Broken cases are left out because nothing can be done with them in
   *  bulk: see `movable`. */
  const selectableIds = useMemo(
    () =>
      groups.flatMap((g) => g.cases.filter((c) => !c.broken).map((c) => c.id)),
    [groups],
  );

  /** The ticked cases, in display order. */
  const ticked = useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected],
  );

  // A case that a filter hid, or that a move carried out of this view, must not
  // stay ticked: a bulk action would then reach rows nobody can see.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(selectableIds);
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectableIds]);

  /** Tick or untick a row. A shift-click covers everything between it and the
   *  anchor, the way a file list does: the anchor stays put, so dragging the
   *  shift-click back over the range unticks what it passes. */
  const toggleSelected = (id: string, range: boolean) => {
    const to = selectableIds.indexOf(id);
    const from = anchor ? selectableIds.indexOf(anchor.id) : -1;
    if (range && anchor && from !== -1 && to !== -1) {
      const [a, b] = from < to ? [from, to] : [to, from];
      setSelected(
        new Set([...anchor.base, ...selectableIds.slice(a, b + 1)]),
      );
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setAnchor({ id, base: next });
  };

  /** Of `ids`, the ones the backend can actually refile. A broken case has front
   *  matter that will not parse, so `move_case` cannot rewrite it and
   *  `reorder_cases` refuses a sequence naming it: leaving it out keeps one bad
   *  file from failing a whole batch. */
  const movable = (ids: string[]) => {
    const broken = new Set(cases.filter((c) => c.broken).map((c) => c.id));
    return ids.filter((id) => !broken.has(id));
  };

  /** Cases were dropped into `section` of the selected suite, at the position
   *  described by `ids`. Whatever already lives there is only reordered; the
   *  rest is a move that carries the new order with it. */
  const dropCasesInGroup = (
    caseIds: string[],
    section: string | null,
    ids: string[],
  ) => {
    if (!activeSuite) return;
    const elsewhere = caseIds.filter((id) => {
      const c = cases.find((x) => x.id === id);
      return c && (c.suite !== activeSuite.id || (c.section ?? null) !== section);
    });
    if (elsewhere.length === 0) {
      reorderCases.mutate({ suite: activeSuite.id, section, ids });
    } else {
      moveCases.mutate({
        ids: elsewhere,
        suite: activeSuite.id,
        section,
        order: ids,
      });
    }
  };

  /** A drag was released. The tree files the cases into a suite or folder; a row
   *  or a group header inside the selected suite also places them. */
  const dropCasesOn = (target: CaseDropTarget, dragged: string[]) => {
    const caseIds = movable(dragged);
    if (caseIds.length === 0) return;
    if (target.kind === "tree") {
      moveCases.mutate({
        ids: caseIds,
        suite: target.suite,
        section: target.section,
      });
      return;
    }
    const group =
      target.kind === "row"
        ? groups.find((g) => g.cases.some((c) => c.id === target.id))
        : groups.find((g) => g.key === target.key);
    if (!group) return;
    const order =
      target.kind === "row"
        ? reorderIds(orderableIds(group), caseIds, target.id, target.after)
        : [
            ...orderableIds(group).filter((id) => !caseIds.includes(id)),
            ...caseIds,
          ];
    dropCasesInGroup(caseIds, group.sectionId, order);
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

        {/* Bulk actions for the ticked rows. Dragging the selection onto a
            suite or folder does the same thing; this is the way that needs no
            drag, and the only one when a filter hides the destination. */}
        {ticked.length > 0 && (
          <div className="flex items-center gap-3 border-b border-border-subtle bg-bg-surface/60 px-6 py-2">
            <span className="text-sm text-text-secondary">
              {ticked.length} selected
            </span>
            <BulkMoveMenu
              suites={suites}
              onMove={(suite, section) => {
                moveCases.mutate({ ids: movable(ticked), suite, section });
                setSelected(new Set());
              }}
            />
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-text-muted hover:text-text-primary"
            >
              Clear
            </button>
          </div>
        )}

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
              previewId={previewId}
              selected={selected}
              ticked={ticked}
              onPreview={(id) => setPreviewId(id)}
              onToggleSelected={toggleSelected}
              onSelectAll={(all) => {
                setSelected(all ? new Set(selectableIds) : new Set());
                setAnchor(null);
              }}
              onOpen={(id) => openCase(id)}
              onDuplicate={(c) => duplicateCase.mutate(c.id)}
              onMove={(c, suite, section) =>
                moveCases.mutate({ ids: [c.id], suite, section })}
              onDropCases={dropCasesOn}
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

      <CaseDragGhost />
    </div>
  );
}

/** The dragged case's title, following the cursor. Its own component so the
 *  pointer position re-renders this alone and not the whole screen, and
 *  `pointer-events-none` so it never hides the target underneath it. */
function CaseDragGhost() {
  const label = useCaseDrag((s) => (s.dragIds.length ? s.label : null));
  const x = useDragPointer((s) => s.x);
  const y = useDragPointer((s) => s.y);
  if (!label) return null;
  return (
    <div
      style={{ left: x + 12, top: y + 12 }}
      className="pointer-events-none fixed z-50 max-w-[16rem] truncate rounded-control border border-border-subtle bg-bg-surface-2 px-2 py-1 text-xs text-text-primary shadow-lg"
    >
      {label}
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

  // Hovering a collapsed suite mid-drag opens it, so a case can be filed into a
  // folder that was not on screen when the drag started.
  const hovered = useCaseDrag((s) =>
    s.dragIds.length && s.target?.kind === "tree" ? s.target.suite : null,
  );
  useEffect(() => {
    if (!hovered || expanded.has(hovered)) return;
    const timer = setTimeout(
      () => setExpanded((prev) => new Set(prev).add(hovered)),
      500,
    );
    return () => clearTimeout(timer);
  }, [hovered, expanded]);

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
                dropSuite={s.id}
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
                    dropSuite={s.id}
                    dropSection={sec.id}
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

/** Every suite with its folders indented under it: the places a case can be
 *  moved to. Shared by the row menu and the bulk bar so both offer the same
 *  destinations in the same order. */
function MoveToList({
  suites,
  here,
  onMove,
}: {
  suites: SuiteTree[];
  /** Marks where the case already sits, when there is a single one. */
  here?: (suite: string, section: string | null) => boolean;
  onMove: (suite: string, section: string | null) => void;
}) {
  const mark = (suite: string, section: string | null) =>
    here?.(suite, section) ? (
      <Check size={12} className="text-brand-primary" />
    ) : undefined;
  return (
    <>
      <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
        Move to
      </div>
      {suites.map((s) => (
        <Fragment key={s.id}>
          <MenuItem
            label={s.name}
            icon={mark(s.id, null)}
            onClick={() => onMove(s.id, null)}
          />
          {s.sections.map((sec) => (
            <MenuItem
              key={sec.id}
              label={sec.name}
              indent
              icon={mark(s.id, sec.id)}
              onClick={() => onMove(s.id, sec.id)}
            />
          ))}
        </Fragment>
      ))}
    </>
  );
}

/** File every ticked case at once, from the bulk bar above the table. */
function BulkMoveMenu({
  suites,
  onMove,
}: {
  suites: SuiteTree[];
  onMove: (suite: string, section: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="secondary" size="md" onClick={() => setOpen((o) => !o)}>
        <FolderInput size={13} /> Move to suite or folder…
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-56 overflow-auto rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
            <MoveToList
              suites={suites}
              onMove={(suite, section) => {
                setOpen(false);
                onMove(suite, section);
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
  dropSuite,
  dropSection,
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
  /** The suite (and folder) a case dropped here is filed into. Rows without a
   *  suite, such as "All cases", are not drop targets. */
  dropSuite?: string;
  dropSection?: string;
  menu?: React.ReactNode;
}) {
  const dropTarget = useCaseDrag(
    (s) =>
      !!dropSuite &&
      s.target?.kind === "tree" &&
      s.target.suite === dropSuite &&
      s.target.section === (dropSection ?? null),
  );
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      {...(dropSuite ? treeTarget(dropSuite, dropSection ?? null) : {})}
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
  previewId,
  selected,
  ticked,
  onPreview,
  onToggleSelected,
  onSelectAll,
  onOpen,
  onDuplicate,
  onMove,
  onDropCases,
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
  /** The case open in the preview panel, highlighted but not ticked. */
  previewId: string | null;
  /** The ticked cases, and the same set in display order. */
  selected: Set<string>;
  ticked: string[];
  onPreview: (id: string) => void;
  onToggleSelected: (id: string, range: boolean) => void;
  onSelectAll: (all: boolean) => void;
  onOpen: (id: string) => void;
  onDuplicate: (c: CaseSummary) => void;
  onMove: (c: CaseSummary, suite: string, section: string | null) => void;
  /** A drag was released over `target`. */
  onDropCases: (target: CaseDropTarget, caseIds: string[]) => void;
  onNudge: (c: CaseSummary, delta: -1 | 1) => void;
  onDelete: (c: CaseSummary) => void;
}) {
  const openAutomation = useSession((s) => s.openAutomation);
  /** The cases being dragged, so their rows can be dimmed. */
  const dragIds = useCaseDrag((s) => s.dragIds);
  /** What the drag would land on: a row edge, or a group header. Row and group
   *  targets are only marked while `reorderable`, so this is null otherwise. */
  const target = useCaseDrag((s) => s.target);
  const over = target?.kind === "row" ? target : null;
  const overGroup = target?.kind === "group" ? target.key : null;

  // A drag outlives the render that started it, and a sync can refresh the
  // cases underneath it. Going through a ref means the drop is worked out from
  // the groups as they stand when the pointer comes up.
  const dropRef = useRef(onDropCases);
  useEffect(() => {
    dropRef.current = onDropCases;
  });
  const drop = (landing: CaseDropTarget, ids: string[]) =>
    dropRef.current(landing, ids);

  const headers = showGroupHeaders && groups.length > 1;
  const columns = 11;
  const selectable = groups.reduce(
    (n, g) => n + g.cases.filter((c) => !c.broken).length,
    0,
  );
  const allTicked = selectable > 0 && ticked.length === selectable;

  return (
    <table className="w-full min-w-[960px] border-collapse text-sm">
      <thead className="sticky top-0 z-10 bg-bg-base">
        <tr className="whitespace-nowrap border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-muted">
          <Th className="w-7 pl-4" />
          <Th className="w-10 pl-1">
            <input
              type="checkbox"
              checked={allTicked}
              ref={(el) => {
                if (el) el.indeterminate = ticked.length > 0 && !allTicked;
              }}
              onChange={(e) => onSelectAll(e.target.checked)}
              title={allTicked ? "Select none" : "Select all"}
              className="accent-brand-primary"
            />
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
        {groups.map((group) => {
          // A row a reorder cannot name (broken, or filed somewhere other than
          // the group it is shown under) must not offer a landing edge: the
          // sequence would not contain it and the case would silently go to the
          // end of the group instead.
          const placeable = reorderable ? new Set(orderableIds(group)) : null;
          return (
          <Fragment key={group.key}>
            {headers && (
              <tr
                // Dropping on a header files the case at the end of that group.
                // Only meaningful while reordering is possible: outside a single
                // suite there is no group to reorder within.
                {...(reorderable ? groupTarget(group.key) : {})}
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
                onClick={(e) => {
                  // The modifiers tick rows, the way a file list does; a plain
                  // click still previews.
                  if (c.broken) onPreview(c.id);
                  else if (e.metaKey || e.ctrlKey) onToggleSelected(c.id, false);
                  else if (e.shiftKey) onToggleSelected(c.id, true);
                  else onPreview(c.id);
                }}
                onDoubleClick={() => onOpen(c.id)}
                // Dragging a ticked row drags every ticked row with it. A broken
                // case cannot be refiled at all, so it does not drag.
                onPointerDown={(e) => {
                  if (c.broken) return;
                  startCaseDrag(
                    e,
                    selected.has(c.id) ? ticked : [c.id],
                    selected.has(c.id) && ticked.length > 1
                      ? `${ticked.length} cases`
                      : c.title,
                    drop,
                  );
                }}
                {...(placeable?.has(c.id) ? rowTarget(c.id) : {})}
                className={cn(
                  "group cursor-pointer whitespace-nowrap border-b border-border-subtle/60",
                  selected.has(c.id)
                    ? "bg-brand-primary/10"
                    : previewId === c.id
                      ? "bg-bg-surface-2/60"
                      : "hover:bg-bg-surface/60",
                  dragIds.includes(c.id) && "opacity-40",
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
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    disabled={c.broken}
                    // The tick is driven from the click, not the change, so a
                    // shift-click can range: `onChange` carries no modifiers.
                    onChange={() => {}}
                    onClick={(e) => onToggleSelected(c.id, e.shiftKey)}
                    title={
                      c.broken
                        ? "This case's front matter does not parse, so it cannot be moved"
                        : `Select ${c.id}`
                    }
                    className="accent-brand-primary disabled:opacity-40"
                  />
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
          );
        })}
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
    // The open menu's backdrop and panel are children of the case row, and a
    // press on either would otherwise bubble into the row's drag.
    <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
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
              <MoveToList
                suites={suites}
                here={here}
                onMove={(suite, section) => {
                  close();
                  onMove(suite, section);
                }}
              />
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
