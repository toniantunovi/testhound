import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Sparkles, X } from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import type { PlaywrightInfo, TestTarget } from "@/lib/types";
import { useAssistant } from "@/store/assistant";
import { usePlaywrightSetup } from "@/store/playwrightSetup";
import { Button } from "@/components/ui/Button";

interface CredRow {
  key: string;
  value: string;
}

/** The Playwright config counts as detected once this appears. The default
 *  testDir we ask the agent to use; matches this repo's convention. */
const TEST_DIR = "./playwright";

/** Build the setup instruction auto-sent to the assistant. The base URL and any
 *  credential VALUES are stored locally and exported into the agent's env; only
 *  their NAMES go into this prompt so nothing secret is written to a transcript. */
export function buildSetupPrompt(baseUrl: string, credKeys: string[]): string {
  const lines = [
    "Set up Playwright for end-to-end testing in this repo, then verify it runs:",
    "1. Add @playwright/test as a dev dependency using the repo's package manager (detect it from the lockfile: package-lock.json -> npm, yarn.lock -> yarn, pnpm-lock.yaml -> pnpm).",
    `2. Create playwright.config.ts with testDir ${TEST_DIR} and use.baseURL read from process.env.BASE_URL. The target base URL is already configured in TestHound (BASE_URL=${baseUrl}) and exported into this session's environment.`,
    "3. Run `npx playwright install` to download the browsers.",
  ];
  let n = 4;
  if (credKeys.length > 0) {
    lines.push(
      `${n}. This app requires login. Add a Playwright "setup" project that logs in once and saves storageState, and have the other projects reuse it (do not log in per test). Read credentials only from these environment variables, which are already set locally in TestHound; never hardcode or print their values: ${credKeys.join(", ")}.`,
    );
    n += 1;
  }
  lines.push(
    `${n}. Add a minimal smoke spec under ${TEST_DIR} that opens the base URL, then verify the setup with \`npx playwright test --list\` followed by a headed run of the smoke spec.`,
  );
  lines.push(
    "Finish with a short summary of what you set up and anything I still need to configure.",
  );
  return lines.join("\n");
}

/** App-wide dialog for the "initialize Playwright" flow. Collects the one input
 *  the setup genuinely needs (BASE_URL) plus optional login credentials, saves
 *  them to the local test target, and hands an enriched setup prompt to the
 *  assistant. Also owns the watcher that clears the initializing state once a
 *  Playwright config appears. Mounted once in the app shell. */
export function InitPlaywrightDialog() {
  const dialogOpen = usePlaywrightSetup((s) => s.dialogOpen);
  const close = usePlaywrightSetup((s) => s.close);
  const begin = usePlaywrightSetup((s) => s.begin);
  const initializing = usePlaywrightSetup((s) => s.initializing);
  const done = usePlaywrightSetup((s) => s.done);
  const queueSend = useAssistant((s) => s.queueSend);
  const qc = useQueryClient();

  const { data: target } = useQuery({
    queryKey: ["test-target"],
    queryFn: api.getTestTarget,
    enabled: dialogOpen,
  });

  // Poll detection while a setup turn runs so the run actions re-enable as soon
  // as the config lands. The dialog is always mounted, so this watcher lives for
  // the whole session; it only polls while initializing.
  const { data: pw } = useQuery<PlaywrightInfo>({
    queryKey: ["playwright-info"],
    queryFn: api.playwrightInfo,
    refetchInterval: initializing ? 2500 : false,
  });
  useEffect(() => {
    if (initializing && pw?.detected) done();
  }, [initializing, pw?.detected, done]);

  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [creds, setCreds] = useState<CredRow[]>([
    { key: "", value: "" },
  ]);

  // Seed the base URL from the saved target the first time it loads.
  const url = baseUrl ?? target?.baseUrl ?? "";

  const save = useMutation({
    mutationFn: (next: TestTarget) => api.setTestTarget(next),
    onError: (e) => window.alert(errMsg(e)),
  });

  if (!dialogOpen) return null;

  const credKeys = needsLogin
    ? creds.map((c) => c.key.trim()).filter(Boolean)
    : [];
  const canConfirm = url.trim().length > 0 && !save.isPending;

  const setCred = (i: number, patch: Partial<CredRow>) =>
    setCreds(creds.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const confirm = async () => {
    // Merge new credentials into the existing env; keep prior values.
    const env: Record<string, string> = { ...(target?.env ?? {}) };
    if (needsLogin) {
      for (const c of creds) {
        const k = c.key.trim();
        if (k) env[k] = c.value;
      }
    }
    try {
      await save.mutateAsync({ baseUrl: url.trim(), env });
    } catch {
      // save.onError surfaced the failure; stay on the dialog so nothing runs.
      return;
    }
    qc.invalidateQueries({ queryKey: ["test-target"] });
    queueSend(buildSetupPrompt(url.trim(), credKeys));
    begin();
    // Reset local edit state for next time.
    setBaseUrl(null);
    setNeedsLogin(false);
    setCreds([{ key: "", value: "" }]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={close} />
      <div className="relative w-[520px] max-w-full rounded-card border border-border-strong bg-bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
          <Sparkles size={15} className="text-brand-accent" />
          <span className="flex-1 text-sm font-semibold text-text-primary">
            Set up Playwright
          </span>
          <button
            onClick={close}
            title="Cancel"
            className="rounded-control p-1 text-text-muted hover:bg-bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-xs leading-relaxed text-text-secondary">
            The assistant will add Playwright, write a config, and install the
            browsers in the background. It just needs to know where your app runs
            and, if it requires login, which credentials to use. Values are
            stored locally (gitignored) and never committed.
          </p>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Base URL
            </label>
            <input
              value={url}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://staging.example.com"
              spellCheck={false}
              autoFocus
              className="h-8 w-full rounded-control border border-border-subtle bg-bg-base px-2.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={needsLogin}
              onChange={(e) => setNeedsLogin(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand-primary"
            />
            This app requires login
          </label>

          {needsLogin && (
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Credential environment variables
              </label>
              <p className="mb-2 text-[11px] text-text-muted">
                The agent wires up a Playwright login (storageState) that reads
                these from the environment.
              </p>
              <div className="flex flex-col gap-1.5">
                {creds.map((c, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <KeyRound size={12} className="shrink-0 text-brand-accent" />
                    <input
                      value={c.key}
                      onChange={(e) => setCred(i, { key: e.target.value })}
                      placeholder="TEST_USER"
                      spellCheck={false}
                      className="h-8 w-44 rounded-control border border-border-subtle bg-bg-base px-2.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
                    />
                    <input
                      value={c.value}
                      onChange={(e) => setCred(i, { value: e.target.value })}
                      placeholder="value"
                      type="password"
                      spellCheck={false}
                      className="h-8 flex-1 rounded-control border border-border-subtle bg-bg-base px-2.5 font-mono text-xs text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none"
                    />
                    <button
                      onClick={() =>
                        setCreds(
                          creds.length > 1
                            ? creds.filter((_, j) => j !== i)
                            : [{ key: "", value: "" }],
                        )
                      }
                      className="rounded-control p-1.5 text-text-muted hover:bg-status-failed/10 hover:text-status-failed"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setCreds([...creds, { key: "", value: "" }])}
                  className="flex w-fit items-center gap-1 rounded-control px-1 py-1 text-xs text-text-secondary hover:text-text-primary"
                >
                  <Plus size={13} /> Add variable
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <Button variant="secondary" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canConfirm}
            onClick={confirm}
          >
            <Sparkles size={13} />
            Set up Playwright
          </Button>
        </div>
      </div>
    </div>
  );
}
