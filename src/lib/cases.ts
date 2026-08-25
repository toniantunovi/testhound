// Search and ordering rules for the case list. Kept out of the screen so the
// case table, the tree and any future picker agree on what "matches" and what
// "comes first" mean.
import type { CaseSummary, RunResultRow, SuiteTree } from "./types";

/** A run of consecutive rows shown under one header: a folder of the selected
 *  suite, or a whole suite in the "All cases" view. */
export interface CaseGroup {
  /** Stable React key, and the drop-target identity while dragging. */
  key: string;
  /** Header label: a folder name, "No folder", or a suite name. */
  label: string;
  /** The folder these cases are filed under on disk, or null for the suite root.
   *  This is what a reorder or a drop targets, so it is the folder id itself and
   *  never derived from a folder object that may have been deleted. Null for the
   *  suite groups of the "All cases" view, which are not reorder targets. */
  sectionId: string | null;
  cases: CaseSummary[];
}

/** The ids a reorder may send for a group: the rows that really live there on
 *  disk, in display order. A broken case has front matter that will not parse,
 *  so there is nothing to write an order into; a case whose folder was deleted is
 *  shown under "No folder" but is still filed elsewhere. Sending either would
 *  make the backend reject the whole reorder. */
export function orderableIds(group: CaseGroup): string[] {
  return group.cases
    .filter((c) => !c.broken && (c.section ?? null) === group.sectionId)
    .map((c) => c.id);
}

/** Normalize an id or a reference for search: lowercased with separators
 *  dropped, so `AB-4821`, `ab4821` and a bare `4821` all compare against the
 *  same key. Mirrors `search_key` in src-tauri/src/repo/runs.rs. */
export function searchKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Does a case match the search box? Titles and tags match as plain substrings.
 *  Ids and references match on their normalized key, so the number alone is
 *  enough: `4821` finds a case referencing AB-4821, and `7` finds TC-0007. */
export function matchesCase(c: CaseSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (c.title.toLowerCase().includes(q)) return true;
  if (c.tags.some((t) => t.toLowerCase().includes(q))) return true;
  const key = searchKey(q);
  if (!key) return false;
  return (
    searchKey(c.id).includes(key) ||
    c.references.some((r) => searchKey(r).includes(key))
  );
}

/** Does a run's case row match the search box? The same rules as the case list,
 *  over what a run carries about a case: the title and where it is filed match
 *  as plain substrings, the id and the defects found against it on their
 *  normalized key. Tags are not on a run row, so they are not searched here. */
export function matchesRunRow(row: RunResultRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.title.toLowerCase().includes(q)) return true;
  if (row.suite.toLowerCase().includes(q)) return true;
  if (row.section?.toLowerCase().includes(q)) return true;
  const key = searchKey(q);
  if (!key) return false;
  return (
    searchKey(row.case).includes(key) ||
    row.defects.some((d) => searchKey(d).includes(key))
  );
}

/** Sort cases the way the tree presents them: by suite order, then by folder
 *  order (cases filed directly under the suite first), then by the manual
 *  per-case order, and by id for anything never reordered. */
export function sortCases(
  cases: CaseSummary[],
  suites: SuiteTree[],
): CaseSummary[] {
  const last = Number.MAX_SAFE_INTEGER;
  const suiteRank = new Map(suites.map((s, i) => [s.id, i]));
  // 0 is reserved for "no folder", so folders start at 1.
  const sectionRank = new Map<string, number>();
  suites.forEach((s) =>
    s.sections.forEach((sec, i) => sectionRank.set(`${s.id}::${sec.id}`, i + 1)),
  );
  const rank = (c: CaseSummary) =>
    c.section ? sectionRank.get(`${c.suite}::${c.section}`) ?? last : 0;

  return [...cases].sort(
    (a, b) =>
      (suiteRank.get(a.suite) ?? last) - (suiteRank.get(b.suite) ?? last) ||
      rank(a) - rank(b) ||
      (a.order ?? last) - (b.order ?? last) ||
      a.id.localeCompare(b.id),
  );
}

/** Split already-sorted cases of one suite into folder groups, in tree order.
 *  Every folder of the suite gets a group even when empty, so a case can be
 *  dragged into a folder that has nothing in it yet. */
export function groupBySection(
  cases: CaseSummary[],
  suite: SuiteTree,
): CaseGroup[] {
  const groups: CaseGroup[] = [
    {
      key: "__root__",
      label: "No folder",
      sectionId: null,
      cases: cases.filter((c) => !c.section),
    },
    ...suite.sections.map((section) => ({
      key: section.id,
      label: section.name,
      sectionId: section.id,
      cases: cases.filter((c) => c.section === section.id),
    })),
  ];
  // Cases pointing at a folder that no longer exists would otherwise vanish
  // from the table; keep them visible under "No folder".
  const known = new Set(suite.sections.map((s) => s.id));
  const orphans = cases.filter((c) => c.section && !known.has(c.section));
  groups[0].cases = [...groups[0].cases, ...orphans];
  return groups;
}

/** Split already-sorted cases into one group per suite, for the "All cases"
 *  view: the list is ordered by suite, so it needs a header to say so. Groups
 *  appear in first-seen order, which `sortCases` has already made suite order,
 *  and a case whose suite is missing keeps its own group rather than vanishing. */
export function groupBySuite(
  cases: CaseSummary[],
  suites: SuiteTree[],
): CaseGroup[] {
  const names = new Map(suites.map((s) => [s.id, s.name]));
  const groups = new Map<string, CaseGroup>();
  for (const c of cases) {
    let group = groups.get(c.suite);
    if (!group) {
      group = {
        key: c.suite,
        label: names.get(c.suite) ?? c.suite,
        sectionId: null,
        cases: [],
      };
      groups.set(c.suite, group);
    }
    group.cases.push(c);
  }
  return [...groups.values()];
}

/** The group's ids after moving `dragIds` next to `targetId`, keeping the
 *  dragged cases in the order they were shown in. The whole group's new order is
 *  what gets sent, so the backend never has to guess an index. */
export function reorderIds(
  groupIds: string[],
  dragIds: string[],
  targetId: string,
  after: boolean,
): string[] {
  const dragged = new Set(dragIds);
  const rest = groupIds.filter((id) => !dragged.has(id));
  const at = rest.indexOf(targetId);
  if (at === -1) return [...rest, ...dragIds];
  rest.splice(at + (after ? 1 : 0), 0, ...dragIds);
  return rest;
}

/** The group's ids after nudging `id` one position up (`delta` -1) or down
 *  (+1). Returns null when it is already at that end. */
export function nudgeIds(
  groupIds: string[],
  id: string,
  delta: -1 | 1,
): string[] | null {
  const from = groupIds.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= groupIds.length) return null;
  const next = [...groupIds];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
