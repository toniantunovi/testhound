import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Local, per-machine preferences (persisted to localStorage). */
interface PrefsState {
  /** Hands-off Git: auto-commit quiet changes, pull/push in the background.
   *  On by default so non-Git users never have to think about it. */
  autoSync: boolean;
  setAutoSync: (on: boolean) => void;

  // ---- Anonymous product telemetry (opt-out) ----------------------------------
  // Strictly anonymous, whitelisted usage stream (see src/lib/telemetry.ts and
  // PRIVACY.md). On by default; a first-run notice explains it and the Settings
  // toggle turns it off. Never carries titles, paths, repo names, or content.

  /** Whether anonymous telemetry may be sent. Opt-out: on by default. */
  analyticsEnabled: boolean;
  setAnalyticsEnabled: (on: boolean) => void;
  /** Stable random id for this install; the only identifier ever sent.
   *  Empty until telemetry first runs, which generates and persists it once. */
  installId: string;
  setInstallId: (id: string) => void;
  /** The one-time first-run telemetry notice has been acknowledged. */
  telemetryNoticeSeen: boolean;
  markTelemetryNoticeSeen: () => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      autoSync: true,
      setAutoSync: (autoSync) => set({ autoSync }),

      analyticsEnabled: true,
      setAnalyticsEnabled: (analyticsEnabled) => set({ analyticsEnabled }),
      installId: "",
      setInstallId: (installId) => set({ installId }),
      telemetryNoticeSeen: false,
      markTelemetryNoticeSeen: () => set({ telemetryNoticeSeen: true }),
    }),
    { name: "testhound-prefs" },
  ),
);
