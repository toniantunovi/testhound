import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Filter, Plus, Search } from "lucide-react";
import { api } from "@/lib/ipc";
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

  const { data: suites = [] } = useQuery({
    queryKey: ["suites"],
    queryFn: api.listSuites,
  });
  const { data: cases = [] } = useQuery({
    queryKey: ["cases"],
    queryFn: api.listCases,
  });

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
            <CaseTable cases={filtered} onOpen={(id) => openCase(id)} />
          )}
        </div>
      </div>
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

function SuiteTreeNav({
  suites,
  totalCount,
  selectedSuite,
  selectedSection,
  onSelect,
}: {
  suites: SuiteTree[];
  totalCount: number;
  selectedSuite: string;
  selectedSection: string | null;
  onSelect: (suite: string, section?: string | null) => void;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-bg-surface/50">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
          Suites
        </span>
        <button className="text-text-muted hover:text-text-primary">
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-2">
        <TreeRow
          label="All cases"
          count={totalCount}
          active={selectedSuite === "all"}
          onClick={() => onSelect("all", null)}
        />
        {suites.map((s) => (
          <div key={s.id}>
            <TreeRow
              label={s.name}
              count={s.caseCount}
              active={selectedSuite === s.id && !selectedSection}
              hasChildren={s.sections.length > 0}
              onClick={() => onSelect(s.id, null)}
            />
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
      </div>
    </aside>
  );
}

function TreeRow({
  label,
  count,
  active,
  indent,
  hasChildren,
  onClick,
}: {
  label: string;
  count?: number;
  active?: boolean;
  indent?: boolean;
  hasChildren?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1 rounded-control py-1.5 pr-2 text-sm transition-colors",
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
      {count !== undefined && (
        <span className="font-mono text-xs text-text-muted">{count}</span>
      )}
    </button>
  );
}

function CaseTable({
  cases,
  onOpen,
}: {
  cases: CaseSummary[];
  onOpen: (id: string) => void;
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
          <Th className="w-20 pr-6">Updated</Th>
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => (
          <tr
            key={c.id}
            onClick={() => onOpen(c.id)}
            className="group cursor-pointer border-b border-border-subtle/60 hover:bg-bg-surface/60"
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
            <td className="py-2 pr-6 text-xs text-text-muted">
              {relativeTime(c.updated)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
