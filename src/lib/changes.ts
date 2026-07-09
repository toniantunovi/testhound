// Semantic grouping of changed TestHound files for the Changes/Commit panel
// (docs/06-ui-ux.md frame 13). The repo is the database, so a raw `git status`
// is regrouped into the domain categories a tester thinks in.
import type { ChangedFile } from "./types";

export type ChangeCategory =
  | "cases"
  | "specs"
  | "results"
  | "automation"
  | "other";

export const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  cases: "Test cases",
  specs: "Playwright specs",
  results: "Results",
  automation: "Automation",
  other: "Project",
};

/** Order groups appear in the panel. */
export const CATEGORY_ORDER: ChangeCategory[] = [
  "cases",
  "specs",
  "results",
  "automation",
  "other",
];

export function categorize(path: string): ChangeCategory {
  if (path.includes("/cases/") && path.endsWith(".md")) return "cases";
  if (/\.(spec|test)\.[tj]sx?$/.test(path)) return "specs";
  if (path.includes("/results/") || /(^|\/)runs\//.test(path)) return "results";
  if (path.includes("automation/")) return "automation";
  return "other";
}

export function groupChanges(
  files: ChangedFile[],
): { category: ChangeCategory; files: ChangedFile[] }[] {
  const map = new Map<ChangeCategory, ChangedFile[]>();
  for (const f of files) {
    const c = categorize(f.path);
    (map.get(c) ?? map.set(c, []).get(c)!).push(f);
  }
  return CATEGORY_ORDER.filter((c) => map.has(c)).map((category) => ({
    category,
    files: map.get(category)!,
  }));
}

/** The `TC-####` id embedded in a case file path, if any. */
export function caseIdFromPath(path: string): string | null {
  return path.match(/TC-\d+/)?.[0] ?? null;
}

/** The suite segment of a `suites/<suite>/...` path, for the commit scope. */
function suiteFromPath(path: string): string | null {
  return path.match(/suites\/([^/]+)\//)?.[1] ?? null;
}

/** A conventional-commit style message drafted from the staged files. Offline
 *  and deterministic; the user edits it before committing. */
export function suggestCommitMessage(files: ChangedFile[]): string {
  if (files.length === 0) return "";
  const groups = groupChanges(files);
  const has = (c: ChangeCategory) =>
    groups.find((g) => g.category === c)?.files ?? [];

  const cases = has("cases");
  const specs = has("specs");
  const added = cases.filter((f) => f.status === "A" || f.status === "??");
  const addedIds = added.map((f) => caseIdFromPath(f.path)).filter(Boolean);

  const scopes = new Set(files.map((f) => suiteFromPath(f.path)).filter(Boolean));
  const scope = scopes.size === 1 ? [...scopes][0] : "tests";

  const parts: string[] = [];
  const modified = cases.length - added.length;
  if (modified > 0) parts.push(`update ${modified} case${modified === 1 ? "" : "s"}`);
  if (addedIds.length)
    parts.push(`add ${addedIds.join(", ")}`);
  if (specs.length) parts.push(`${specs.length} spec${specs.length === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push("update test assets");

  const subject = `test(${scope}): ${parts.join(", ")}`;

  const body: string[] = [];
  for (const g of groups) {
    const label = CATEGORY_LABEL[g.category].toLowerCase();
    body.push(`- ${g.files.length} ${label} file${g.files.length === 1 ? "" : "s"} changed`);
  }
  return `${subject}\n\n${body.join("\n")}`;
}
