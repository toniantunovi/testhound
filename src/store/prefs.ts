import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Local, per-machine preferences (persisted to localStorage). */
interface PrefsState {
  /** Hands-off Git: auto-commit quiet changes, pull/push in the background.
   *  On by default so non-Git users never have to think about it. */
  autoSync: boolean;
  setAutoSync: (on: boolean) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      autoSync: true,
      setAutoSync: (autoSync) => set({ autoSync }),
    }),
    { name: "testhound-prefs" },
  ),
);
