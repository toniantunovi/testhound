// A tiny line-based diff for the generated-spec review. Not a full Myers diff:
// an LCS table over lines, which is plenty for spec files (hundreds of lines).

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old file, if present. */
  oldNo: number | null;
  /** 1-based line number in the new file, if present. */
  newNo: number | null;
}

/** Longest-common-subsequence line diff. `old` null means a brand-new file. */
export function lineDiff(old: string | null, next: string): DiffLine[] {
  const a = old === null ? [] : old.replace(/\n$/, "").split("\n");
  const b = next.replace(/\n$/, "").split("\n");

  // LCS length table.
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i], oldNo: oldNo++, newNo: null });
      i++;
    } else {
      out.push({ kind: "add", text: b[j], oldNo: null, newNo: newNo++ });
      j++;
    }
  }
  while (i < m) out.push({ kind: "del", text: a[i++], oldNo: oldNo++, newNo: null });
  while (j < n) out.push({ kind: "add", text: b[j++], oldNo: null, newNo: newNo++ });
  return out;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  return {
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "del").length,
  };
}
