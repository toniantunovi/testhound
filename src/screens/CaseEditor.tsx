import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  Check,
  GitBranch,
  History,
  Loader2,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type {
  CaseStatus,
  CaseType,
  Priority,
  TestCase,
} from "@/lib/types";
import { useSession } from "@/store/session";
import { useAssistant } from "@/store/assistant";
import { usePlaywrightSetup } from "@/store/playwrightSetup";
import { AutomationBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { SpecEditorModal } from "./SpecEditorModal";

const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];
const TYPES: CaseType[] = [
  "functional",
  "regression",
  "smoke",
  "e2e",
  "negative",
  "a11y",
  "perf",
];
const STATUSES: CaseStatus[] = ["draft", "active", "deprecated"];

export function CaseEditor() {
  const id = useSession((s) => s.openCaseId);
  const navigate = useSession((s) => s.navigate);
  const openCaseHistory = useSession((s) => s.openCaseHistory);
  const openAutomation = useSession((s) => s.openAutomation);
  const startGeneration = useAssistant((s) => s.startGeneration);
  const openPwSetup = usePlaywrightSetup((s) => s.open);
  const pwInitializing = usePlaywrightSetup((s) => s.initializing);
  const qc = useQueryClient();

  const { data: pw } = useQuery({
    queryKey: ["playwright-info"],
    queryFn: api.playwrightInfo,
  });

  const { data: loaded } = useQuery({
    queryKey: ["case", id],
    queryFn: () => api.getCase(id!),
    enabled: !!id,
  });

  const [draft, setDraft] = useState<TestCase | null>(null);
  const [dirty, setDirty] = useState(false);
  // Repo-relative path of the spec being viewed/edited, if the modal is open.
  const [openSpecPath, setOpenSpecPath] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) {
      setDraft(loaded);
      setDirty(false);
    }
  }, [loaded]);

  const save = useMutation({
    mutationFn: (c: TestCase) => api.saveCase(c),
    onSuccess: (saved) => {
      setDraft(saved);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", saved.id] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
  });

  // Ad-hoc: run this case's spec in a visible browser to watch it, without
  // creating a run. Output streams to the Activity console.
  const runSpec = useMutation({
    mutationFn: (caseId: string) => api.runCaseSpec(caseId, true),
    onError: (e) => window.alert(errMsg(e)),
  });

  const remove = useMutation({
    mutationFn: (caseId: string) => api.deleteCase(caseId),
    onSuccess: () => {
      ["cases", "suites", "coverage", "dashboard", "git-status"].forEach((k) =>
        qc.invalidateQueries({ queryKey: [k] }),
      );
      navigate("cases");
    },
  });

  const confirmDelete = async () => {
    if (!draft) return;
    const ok = await ask(
      `Delete ${draft.id} "${draft.title}"?\n\nThe file is removed from the working tree; review and commit the deletion in the Changes panel.`,
      { title: "Delete case", kind: "warning" },
    );
    if (ok) remove.mutate(draft.id);
  };

  if (!draft) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        Loading case…
      </div>
    );
  }

  const patch = (p: Partial<TestCase>) => {
    setDraft({ ...draft, ...p });
    setDirty(true);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-3">
        <button
          onClick={() => navigate("cases")}
          className="text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="font-mono text-xs text-brand-primary">{draft.id}</span>
        <span className="font-mono text-xs text-text-muted">·</span>
        <span className="truncate font-mono text-xs text-text-muted">
          {draft.suite}
          {draft.section ? ` / ${draft.section}` : ""}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openCaseHistory(draft.id)}
        >
          <History size={13} /> History
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={confirmDelete}
          disabled={remove.isPending}
          className="text-text-muted hover:text-status-failed"
        >
          <Trash2 size={13} /> Delete
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isSuccess && !dirty ? <Check size={13} /> : <Save size={13} />}
          {dirty ? "Save" : "Saved"}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Center: title + steps + body */}
        <div className="min-w-0 flex-1 overflow-auto px-8 py-6">
          <input
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            className="w-full bg-transparent text-xl font-semibold tracking-tight text-text-primary focus:outline-none"
          />

          {/* Rendered steps table */}
          <section className="mt-6">
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Steps
            </h2>
            <div className="overflow-hidden rounded-card border border-border-subtle">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle bg-bg-surface text-left text-[11px] uppercase tracking-wider text-text-muted">
                    <th className="w-10 py-1.5 pl-3">#</th>
                    <th className="py-1.5">Action</th>
                    <th className="py-1.5 pr-3">Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.steps.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="p-3 text-text-muted">
                        No steps parsed. Edit the Markdown below.
                      </td>
                    </tr>
                  ) : (
                    draft.steps.map((s) => (
                      <tr key={s.number} className="border-b border-border-subtle/60">
                        <td className="py-2 pl-3 font-mono text-xs text-text-muted">
                          {s.number}
                        </td>
                        <td className="py-2 pr-4 text-text-primary">{s.action}</td>
                        <td className="py-2 pr-3 text-text-secondary">
                          {s.expected ?? "-"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Raw Markdown body */}
          <section className="mt-6">
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Markdown source
            </h2>
            <textarea
              value={draft.body}
              onChange={(e) => patch({ body: e.target.value })}
              spellCheck={false}
              className="selectable h-72 w-full resize-none rounded-card border border-border-subtle bg-bg-surface p-3 font-mono text-[13px] leading-relaxed text-text-primary focus:border-border-strong focus:outline-none"
            />
            <p className="mt-1.5 text-xs text-text-muted">
              Steps re-parse from this Markdown on save.
            </p>
          </section>
        </div>

        {/* Right rail */}
        <aside className="w-72 shrink-0 overflow-auto border-l border-border-subtle bg-bg-surface/50 p-4">
          <Field label="Priority">
            <Select
              value={draft.priority}
              options={PRIORITIES}
              onChange={(v) => patch({ priority: v as Priority })}
            />
          </Field>
          <Field label="Type">
            <Select
              value={draft.type}
              options={TYPES}
              onChange={(v) => patch({ type: v as CaseType })}
            />
          </Field>
          <Field label="Status">
            <Select
              value={draft.status}
              options={STATUSES}
              onChange={(v) => patch({ status: v as CaseStatus })}
            />
          </Field>
          <Field label="Owner">
            <input
              value={draft.owner ?? ""}
              onChange={(e) => patch({ owner: e.target.value })}
              placeholder="unassigned"
              className="h-8 w-full rounded-control border border-border-subtle bg-bg-base px-2 text-sm text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
            />
          </Field>
          <Field label="Tags">
            <div className="flex flex-wrap gap-1.5">
              {draft.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-control bg-bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-secondary"
                >
                  {t}
                </span>
              ))}
              {draft.tags.length === 0 && (
                <span className="text-xs text-text-muted">No tags</span>
              )}
            </div>
          </Field>
          <Field label="References">
            <ReferencesEditor
              references={draft.references}
              onChange={(references) => patch({ references })}
            />
          </Field>

          {/* Automation panel */}
          <div className="mt-5 rounded-card border border-border-subtle bg-bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Automation
              </span>
              <AutomationBadge
                state={draft.automation.state}
                onClick={() => openAutomation(draft.id)}
              />
            </div>
            {draft.automation.specs && draft.automation.specs.length > 0 ? (
              <div className="mb-3 flex flex-col gap-1">
                {draft.automation.specs.map((spec) => (
                  <button
                    key={spec}
                    title="View and edit the spec code"
                    onClick={() => setOpenSpecPath(spec.split("#")[0])}
                    className="flex w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-left font-mono text-xs text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary"
                  >
                    <GitBranch size={11} className="shrink-0 text-brand-accent" />
                    <span className="truncate underline decoration-border-strong decoration-dotted underline-offset-2">
                      {spec}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mb-3 text-xs text-text-muted">
                No linked Playwright spec yet.
              </p>
            )}
            {draft.automation.specs && draft.automation.specs.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                className="mb-2 w-full"
                disabled={runSpec.isPending || pwInitializing}
                title={
                  pw?.detected
                    ? "Run this spec now in a visible browser (does not create a run)"
                    : "Playwright is not set up in this repo. Click to initialize it, then run."
                }
                onClick={() =>
                  pw?.detected ? runSpec.mutate(draft.id) : openPwSetup()
                }
              >
                {pwInitializing ? (
                  <>
                    <Loader2 size={13} className="animate-spin text-brand-accent" />
                    Initializing Playwright…
                  </>
                ) : (
                  <>
                    <Play size={13} className="text-brand-accent" />
                    Run in browser
                  </>
                )}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              className={cn(
                "w-full",
                draft.automation.state === "drifted" &&
                  "border-status-drifted/40 text-status-drifted",
              )}
              onClick={() => {
                const update = draft.automation.state === "drifted";
                api
                  .generationPrompt(draft.id, update)
                  .then((p) => startGeneration(draft.id, update, p))
                  .catch((e) => window.alert(errMsg(e)));
              }}
            >
              <Sparkles size={13} className="text-brand-accent" />
              {draft.automation.state === "none"
                ? "Generate automation"
                : draft.automation.state === "drifted"
                  ? "Update spec"
                  : "Regenerate"}
            </Button>
          </div>
        </aside>
      </div>

      {openSpecPath && (
        <SpecEditorModal
          path={openSpecPath}
          onClose={() => setOpenSpecPath(null)}
        />
      )}
    </div>
  );
}

/** Editable list of external references (Jira keys, ticket URLs, docs).
 *  URLs open in the system browser; anything else is shown as plain text. */
function ReferencesEditor({
  references,
  onChange,
}: {
  references: string[];
  onChange: (refs: string[]) => void;
}) {
  const [value, setValue] = useState("");

  const add = () => {
    const v = value.trim();
    if (!v || references.includes(v)) return;
    onChange([...references, v]);
    setValue("");
  };

  return (
    <div>
      {references.length > 0 && (
        <div className="mb-1.5 flex flex-col gap-1">
          {references.map((r) => (
            <div
              key={r}
              className="group flex items-center gap-1.5 rounded-control bg-bg-surface-2/60 px-1.5 py-1"
            >
              {/^https?:\/\//i.test(r) ? (
                <button
                  onClick={() => api.openUrl(r)}
                  title={r}
                  className="min-w-0 flex-1 truncate text-left font-mono text-xs text-brand-primary underline decoration-border-strong decoration-dotted underline-offset-2 hover:decoration-brand-primary"
                >
                  {r}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                  {r}
                </span>
              )}
              <button
                onClick={() => onChange(references.filter((x) => x !== r))}
                title="Remove reference"
                className="shrink-0 text-text-muted opacity-0 transition-opacity hover:text-status-failed group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="PROJ-123 or https://…"
          className="h-8 min-w-0 flex-1 rounded-control border border-border-subtle bg-bg-base px-2 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
        />
        <button
          onClick={add}
          disabled={!value.trim()}
          title="Add reference"
          className="rounded-control border border-border-subtle p-1.5 text-text-muted hover:text-text-primary disabled:opacity-40"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-control border border-border-subtle bg-bg-base px-2 text-sm capitalize text-text-primary focus:border-border-strong focus:outline-none"
    >
      {options.map((o) => (
        <option key={o} value={o} className="bg-bg-surface capitalize">
          {o}
        </option>
      ))}
    </select>
  );
}
