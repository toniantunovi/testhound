// The filter-query language, from the picker's side: which typed terms a set of
// ticked facets means, and whether a hand-written query says something the
// picker can show. The engine that evaluates a query lives in Rust
// (`matches_query` in src-tauri/src/repo/runs.rs); this only writes and reads
// back the subset a facet picker can express.

/** The facets the picker offers, in the order they appear in a built query. */
export const FACET_KEYS = ["suite", "type", "priority", "status", "tag"] as const;

export type FacetKey = (typeof FACET_KEYS)[number];

/** The ticked values per facet. Values within one facet are an either-or; the
 *  facets themselves are ANDed together. */
export type Facets = Record<FacetKey, string[]>;

export const emptyFacets = (): Facets => ({
  suite: [],
  type: [],
  priority: [],
  status: [],
  tag: [],
});

export const facetCount = (facets: Facets): number =>
  FACET_KEYS.reduce((n, key) => n + facets[key].length, 0);

/** The query a set of ticked facets means. Several values in one facet become
 *  the comma list a typed term takes (`type:regression,smoke`), which is what
 *  keeps an either-or ANDed with the rest: the language has no parentheses.
 *
 *  The query, not the ticks, is what a run stores, so the picker is a way of
 *  writing one rather than a second definition of membership. */
export function buildQuery(facets: Facets): string {
  return FACET_KEYS.filter((key) => facets[key].length > 0)
    .map((key) => `${key}:${facets[key].join(",")}`)
    .join(" AND ");
}

/** Read a query back into ticked facets, or `null` when it says something the
 *  picker cannot: an `OR` group, a free-text term, a key the picker does not
 *  offer, the same facet twice (an AND of two values, not an either-or), or a
 *  value outside `allowed`. Nothing is dropped quietly: a query the chips would
 *  misrepresent stays in the text box instead.
 *
 *  Values are matched against `allowed` case-insensitively and come back in the
 *  spelling `allowed` has, so a parsed value ticks the chip that produced it. */
export function parseQuery(
  query: string,
  allowed: Record<FacetKey, readonly string[]>,
): Facets | null {
  const facets = emptyFacets();
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const word = token.toUpperCase();
    if (word === "AND") continue;
    if (word === "OR") return null;

    const at = token.indexOf(":");
    if (at < 1) return null;
    const key = token.slice(0, at).toLowerCase() as FacetKey;
    if (!FACET_KEYS.includes(key)) return null;
    if (facets[key].length > 0) return null;

    const values = token
      .slice(at + 1)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => allowed[key].find((a) => a.toLowerCase() === v.toLowerCase()));
    if (values.length === 0 || values.some((v) => v === undefined)) return null;
    facets[key] = values as string[];
  }
  return facets;
}
