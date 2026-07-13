import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Database,
  Download,
  Globe,
  Plus,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { UpdateInfo } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { usePrefs } from "@/store/prefs";

export function Settings() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-subtle px-8 py-5">
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          <AutoSyncSection />
          <TestTargetSection />
          <LfsSection />
          <UpdatesSection />
        </div>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  blurb,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-text-secondary">{blurb}</p>
      {children}
    </section>
  );
}

function AutoSyncSection() {
  const autoSync = usePrefs((s) => s.autoSync);
  const setAutoSync = usePrefs((s) => s.setAutoSync);

  return (
    <Section
      icon={<RefreshCw size={15} className="text-brand-accent" />}
      title="Automatic sync"
      blurb="TestHound handles Git for you: your saved work is committed automatically after a short pause, and the project pulls and pushes in the background so everyone stays on the latest state. Only TestHound's own files are committed (cases, runs, and specs linked to a case); anything else in the repository is left alone. Only conflicting edits ever need your attention. Turn this off to review, commit, and sync manually."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm">
          {autoSync ? (
            <span className="inline-flex items-center gap-1.5 text-status-passed">
              <Check size={14} /> On, changes are committed and synced for you
            </span>
          ) : (
            <span className="text-text-secondary">
              Off, you commit and sync manually
            </span>
          )}
        </div>
        <Button
          variant={autoSync ? "secondary" : "primary"}
          onClick={() => setAutoSync(!autoSync)}
        >
          {autoSync ? "Turn off" : "Turn on"}
        </Button>
      </div>
    </Section>
  );
}

interface EnvRow {
  key: string;
  value: string;
}

function TestTargetSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["test-target"],
    queryFn: api.getTestTarget,
  });

  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [rows, setRows] = useState<EnvRow[] | null>(null);

  // Seed local edit state from the loaded target once.
  const loadedBaseUrl = baseUrl ?? data?.baseUrl ?? "";
  const loadedRows =
    rows ??
    Object.entries(data?.env ?? {}).map(([key, value]) => ({ key, value }));

  const save = useMutation({
    mutationFn: () => {
      const env: Record<string, string> = {};
      for (const r of loadedRows) {
        const k = r.key.trim();
        if (k) env[k] = r.value;
      }
      return api.setTestTarget({
        baseUrl: loadedBaseUrl.trim() || null,
        env,
      });
    },
    onSuccess: () => {
      // Base URL feeds the generate-spec context; refresh dependents.
      qc.invalidateQueries({ queryKey: ["test-target"] });
      setBaseUrl(null);
      setRows(null);
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const setRow = (i: number, patch: Partial<EnvRow>) =>
    setRows(loadedRows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows([...loadedRows, { key: "", value: "" }]);
  const removeRow = (i: number) =>
    setRows(loadedRows.filter((_, j) => j !== i));

  return (
    <Section
      icon={<Globe size={15} className="text-brand-accent" />}
      title="Test target"
      blurb="Where Playwright runs point. The base URL is passed to each run as BASE_URL, PLAYWRIGHT_TEST_BASE_URL and PLAYWRIGHT_BASE_URL, and is used when the agent generates specs. Have your playwright config read it, e.g. baseURL: process.env.BASE_URL. Stored locally (gitignored), never committed."
    >
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
        Base URL
      </label>
      <input
        value={loadedBaseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="https://staging.example.com"
        spellCheck={false}
        className="mb-4 h-8 w-full rounded-control border border-border-subtle bg-bg-base px-2.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
      />

      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
        Environment variables
      </label>
      <div className="flex flex-col gap-1.5">
        {loadedRows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={r.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
              placeholder="KEY"
              spellCheck={false}
              className="h-8 w-44 rounded-control border border-border-subtle bg-bg-base px-2.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
            />
            <input
              value={r.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              placeholder="value"
              spellCheck={false}
              className="h-8 flex-1 rounded-control border border-border-subtle bg-bg-base px-2.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
            />
            <button
              onClick={() => removeRow(i)}
              className="rounded-control p-1.5 text-text-muted hover:bg-status-failed/10 hover:text-status-failed"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          onClick={addRow}
          className="flex w-fit items-center gap-1 rounded-control px-1 py-1 text-xs text-text-secondary hover:text-text-primary"
        >
          <Plus size={13} /> Add variable
        </button>
      </div>

      <div className="mt-4">
        <Button
          variant="primary"
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isSuccess ? <Check size={13} /> : null}
          Save target
        </Button>
      </div>
    </Section>
  );
}

function LfsSection() {
  const qc = useQueryClient();
  const { data: lfs } = useQuery({ queryKey: ["lfs-status"], queryFn: api.lfsStatus });
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: () => (lfs?.enabled ? api.disableLfs() : api.enableLfs()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lfs-status"] }),
    onError: (e) => setError(errMsg(e)),
  });

  return (
    <Section
      icon={<Database size={15} className="text-brand-primary" />}
      title="Evidence storage (Git LFS)"
      blurb="By default large traces and videos are gitignored with a pointer. Opt in to Git LFS to version the evidence you want to keep alongside your test cases."
    >
      {error && <p className="mb-3 text-xs text-status-failed">{error}</p>}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm">
          {lfs?.enabled ? (
            <span className="inline-flex items-center gap-1.5 text-status-passed">
              <Check size={14} /> Enabled
            </span>
          ) : (
            <span className="text-text-secondary">Not enabled</span>
          )}
        </div>
        <Button
          variant={lfs?.enabled ? "secondary" : "primary"}
          disabled={toggle.isPending || !lfs}
          onClick={() => {
            setError(null);
            toggle.mutate();
          }}
        >
          {lfs?.enabled ? "Disable LFS tracking" : "Enable LFS tracking"}
        </Button>
      </div>

      {lfs && !lfs.lfsAvailable && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-status-drifted">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>
            The <span className="font-mono">git-lfs</span> binary was not found
            on PATH. TestHound still writes the tracking rules, but you&apos;ll
            need to install Git LFS for them to take effect.
          </span>
        </p>
      )}

      {lfs && lfs.patterns.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-text-muted">
            Tracked patterns
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {lfs.patterns.map((p) => (
              <li
                key={p}
                className="rounded-control border border-border-subtle bg-bg-base px-1.5 py-0.5 font-mono text-[11px] text-text-secondary"
              >
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function UpdatesSection() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [installed, setInstalled] = useState(false);

  const check = useMutation({
    mutationFn: api.checkForUpdate,
    onSuccess: setInfo,
  });
  const install = useMutation({
    mutationFn: api.installUpdate,
    onSuccess: () => setInstalled(true),
  });

  return (
    <Section
      icon={<RefreshCw size={15} className="text-brand-primary" />}
      title="Updates"
      blurb="TestHound checks a signed release feed for new versions. Updates are verified against the app's public key before install."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-text-secondary">
          {info ? (
            <span className="font-mono text-xs">
              Current: v{info.currentVersion}
            </span>
          ) : (
            "Check for a newer version."
          )}
        </div>
        <Button
          disabled={check.isPending}
          onClick={() => {
            setInstalled(false);
            check.mutate();
          }}
        >
          <RefreshCw
            size={13}
            className={check.isPending ? "animate-spin" : undefined}
          />
          Check for updates
        </Button>
      </div>

      {info && !info.error && info.available && (
        <div className="mt-4 rounded-control border border-brand-primary/25 bg-brand-primary/5 p-3">
          <div className="mb-1 text-sm font-medium text-text-primary">
            Version {info.version} is available
          </div>
          {info.notes && (
            <p className="mb-3 whitespace-pre-wrap text-xs text-text-secondary">
              {info.notes}
            </p>
          )}
          {installed ? (
            <p className="text-xs text-status-passed">
              Update installed. Restart TestHound to apply it.
            </p>
          ) : (
            <Button
              variant="primary"
              disabled={install.isPending}
              onClick={() => install.mutate()}
            >
              <Download size={13} />
              {install.isPending ? "Downloading…" : "Download & install"}
            </Button>
          )}
        </div>
      )}

      {info && !info.error && !info.available && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-status-passed">
          <Check size={13} /> You&apos;re on the latest version.
        </p>
      )}

      {info?.error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-text-muted">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{info.error}</span>
        </p>
      )}
    </Section>
  );
}
