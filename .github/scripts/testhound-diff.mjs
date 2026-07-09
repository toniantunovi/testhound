// TestHound PR-diff renderer (docs/04-git-storage.md §4.4).
//
// Renders a human-readable summary of the test-case changes in a pull request
// and posts (or updates) a single PR comment. Because TestHound cases are plain
// Markdown + YAML front matter, reviewers otherwise see raw file diffs; this
// turns them into "TC-0007: priority high -> critical, +1 step" style notes.
//
// Dependency-free: uses the `git` CLI and Node's global fetch. Expects env:
//   GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), PR_NUMBER, BASE_SHA, HEAD_SHA

import { execFileSync } from "node:child_process";

const MARKER = "<!-- testhound-pr-diff -->";
const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, BASE_SHA, HEAD_SHA } =
  process.env;

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Silence child stderr: expected lookups (a file absent in the base ref)
    // print "fatal:" and are handled by the caller.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** A path is a TestHound case file when it's a `.md` under a suite's `cases/`. */
function isCaseFile(path) {
  return path.endsWith(".md") && path.includes("/cases/") && path.includes("/suites/");
}

function showAt(ref, path) {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/** Minimal front-matter + step parse, mirroring the Rust case_file reader. */
function parseCase(content) {
  if (!content) return null;
  const fm = {};
  let body = content;
  const m = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    let nested = false;
    for (const line of m[1].split(/\r?\n/)) {
      if (/^\S.*:$/.test(line)) {
        // A top-level key with a nested block (e.g. `automation:`); skip its
        // children until the indentation returns to column 0.
        nested = true;
        continue;
      }
      if (nested && /^\s/.test(line)) continue;
      nested = false;
      const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
  }
  const steps = [];
  let inSteps = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      inSteps = h[1].trim().toLowerCase() === "steps";
      continue;
    }
    if (!inSteps) continue;
    const step = line.match(/^(\d+)\.\s+(.*)$/);
    if (step) steps.push({ action: step[2], expected: null });
    const exp = line.match(/^-\s+\*\*expected:?\*\*:?\s*(.*)$/i);
    if (exp && steps.length) steps[steps.length - 1].expected = exp[1];
  }
  return { fm, steps };
}

const FIELDS = ["title", "suite", "section", "priority", "type", "status", "owner"];

function renderChange(status, path, oldC, newC) {
  const id = (newC?.fm.id || oldC?.fm.id || path).toString();
  const title = (newC?.fm.title || oldC?.fm.title || "").toString();
  const head = `**${id}** ${title}`.trim();

  if (status === "A") return `- 🟢 ${head} _(new case)_`;
  if (status === "D") return `- 🔴 ~~${head}~~ _(deleted)_`;

  const notes = [];
  for (const f of FIELDS) {
    const a = oldC?.fm[f] ?? "";
    const b = newC?.fm[f] ?? "";
    if (a !== b) notes.push(`${f}: \`${a || "∅"}\` → \`${b || "∅"}\``);
  }
  const oldN = oldC?.steps.length ?? 0;
  const newN = newC?.steps.length ?? 0;
  if (oldN !== newN) {
    const delta = newN - oldN;
    notes.push(`steps: ${oldN} → ${newN} (${delta > 0 ? "+" : ""}${delta})`);
  } else if (
    oldC &&
    newC &&
    JSON.stringify(oldC.steps) !== JSON.stringify(newC.steps)
  ) {
    notes.push("steps edited");
  }
  if (notes.length === 0) return `- ⚪ ${head} _(non-semantic change)_`;
  return `- 🟡 ${head}\n${notes.map((n) => `    - ${n}`).join("\n")}`;
}

function buildBody(rows) {
  if (rows.length === 0) {
    return `${MARKER}\n### 🐾 TestHound\nNo test-case changes in this PR.`;
  }
  return [
    MARKER,
    "### 🐾 TestHound test-case changes",
    "",
    `${rows.length} case file${rows.length === 1 ? "" : "s"} changed:`,
    "",
    ...rows,
    "",
    "<sub>Rendered from the Markdown/YAML case files. Legend: 🟢 new · 🟡 changed · 🔴 deleted.</sub>",
  ].join("\n");
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "testhound-pr-diff",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function upsertComment(body) {
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const base = `/repos/${owner}/${repo}`;
  const comments = await api("GET", `${base}/issues/${PR_NUMBER}/comments?per_page=100`);
  const existing = comments.find((c) => c.body?.includes(MARKER));
  if (existing) {
    await api("PATCH", `${base}/issues/comments/${existing.id}`, { body });
  } else {
    await api("POST", `${base}/issues/${PR_NUMBER}/comments`, { body });
  }
}

async function main() {
  const nameStatus = git([
    "diff",
    "--name-status",
    "-M",
    `${BASE_SHA}...${HEAD_SHA}`,
  ]).trim();

  const rows = [];
  for (const line of nameStatus ? nameStatus.split("\n") : []) {
    const parts = line.split("\t");
    const code = parts[0][0]; // A/M/D/R
    const path = code === "R" ? parts[2] : parts[1];
    const oldPath = code === "R" ? parts[1] : parts[1];
    if (!isCaseFile(path) && !isCaseFile(oldPath)) continue;
    const oldC = parseCase(showAt(BASE_SHA, oldPath));
    const newC = code === "D" ? null : parseCase(showAt(HEAD_SHA, path));
    rows.push(renderChange(code === "R" ? "M" : code, path, oldC, newC));
  }

  const body = buildBody(rows);
  if (!GITHUB_TOKEN || !PR_NUMBER) {
    // Local dry-run: print instead of posting.
    console.log(body);
    return;
  }
  await upsertComment(body);
  console.log(`Posted TestHound diff for ${rows.length} case change(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
