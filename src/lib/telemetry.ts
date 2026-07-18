// Anonymous product telemetry (opt-out). One `track()` call per whitelisted
// event, fire-and-forget: it can never throw into or slow down the app.
//
// PRIVACY (non-negotiable, mirrored in PRIVACY.md and the Settings disclosure):
// the ONLY things ever sent are a random `install_id`, the event name, the app
// version, the OS family, and the whitelisted numeric/enum props each call site
// passes. Never case titles, file paths, repo names/URLs, git remotes, branch
// names, code, spec contents, base URLs, or environment variables.
//
// Sending is suppressed when: the user turned it off in Settings, the browser
// signals Do-Not-Track, or the `TESTHOUND_TELEMETRY` env var opts out.
//
// The actual POST runs in Rust (`telemetry_capture`), not here: a webview
// `fetch` can be blocked by content blockers or webview quirks, and routing
// through Rust also keeps the capture key and ingestion host out of the JS
// bundle. Rust stamps `app_version` and `os` and enforces the env-var opt-out.
import { invoke } from "@tauri-apps/api/core";
import { usePrefs } from "@/store/prefs";

/** The eight whitelisted events. Anything outside this union is a mistake. */
export type TelemetryEvent =
  | "app_launched"
  | "project_opened"
  | "case_created"
  | "run_created"
  | "result_recorded"
  | "spec_generated"
  | "spec_accepted"
  | "sync_performed";

/** Only whitelisted numeric/enum/bool props are ever attached. */
type Props = Record<string, string | number | boolean>;

function doNotTrack(): boolean {
  const w = window as unknown as { doNotTrack?: string };
  const n = navigator as unknown as { doNotTrack?: string; msDoNotTrack?: string };
  return (
    n.doNotTrack === "1" ||
    w.doNotTrack === "1" ||
    n.msDoNotTrack === "1" ||
    n.doNotTrack === "yes"
  );
}

/** Ensure a stable install id exists, generating and persisting it once. */
function ensureInstallId(): string {
  let { installId } = usePrefs.getState();
  if (!installId) {
    installId = crypto.randomUUID();
    usePrefs.getState().setInstallId(installId);
  }
  return installId;
}

/** Send one event. Never throws; returns immediately if telemetry is off. */
export async function track(event: TelemetryEvent, props?: Props): Promise<void> {
  try {
    if (!usePrefs.getState().analyticsEnabled) return;
    if (doNotTrack()) return;
    // Rust does the POST and stamps app_version/os; it also enforces the
    // env-var opt-out authoritatively.
    await invoke("telemetry_capture", {
      event,
      distinctId: ensureInstallId(),
      props: props ?? {},
    });
  } catch {
    // Telemetry must never surface an error to the user or block a flow.
  }
}

/** Bucket a count into the whitelisted coarse bands (never the raw number). */
export function countBucket(n: number): string {
  if (n <= 1) return "1";
  if (n <= 10) return "2-10";
  if (n <= 50) return "11-50";
  return "50+";
}
