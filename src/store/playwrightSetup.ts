import { create } from "zustand";

/** Drives the "initialize Playwright" flow: the input dialog and the
 *  "Initializing Playwright…" progress state shown on run actions while the
 *  background assistant sets Playwright up. Detection completing (a
 *  `playwright.config` appearing) is what clears `initializing`; see
 *  InitPlaywrightDialog's watcher. */
interface PlaywrightSetupState {
  /** The BASE_URL + credentials dialog is open. */
  dialogOpen: boolean;
  /** A setup turn was kicked off and Playwright is not detected yet. */
  initializing: boolean;
  open: () => void;
  close: () => void;
  /** Dialog confirmed: close it and enter the initializing state. */
  begin: () => void;
  /** Playwright detected: leave the initializing state. */
  done: () => void;
}

export const usePlaywrightSetup = create<PlaywrightSetupState>((set) => ({
  dialogOpen: false,
  initializing: false,
  open: () => set({ dialogOpen: true }),
  close: () => set({ dialogOpen: false }),
  begin: () => set({ dialogOpen: false, initializing: true }),
  done: () => set({ initializing: false }),
}));
