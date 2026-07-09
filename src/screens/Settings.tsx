import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Database,
  Download,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { UpdateInfo } from "@/lib/types";
import { Button } from "@/components/ui/Button";

export function Settings() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-subtle px-8 py-5">
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
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
