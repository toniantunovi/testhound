import { create } from "zustand";
import type { StepBeginEvent } from "@/lib/types";

/**
 * State for a step-through case preview: the browser pauses before each action
 * and the user advances one at a time. Only one session runs at a time. Events
 * (`step://begin`, `run://finished`) are fed in from the global run subscriber;
 * CaseEditor renders the controls.
 */
interface StepState {
  /** Run id of the active stepped preview (`step:<caseId>`), or null when idle. */
  runId: string | null;
  /** The case being stepped, so a screen can show controls only for its case. */
  caseId: string | null;
  /** Every action seen so far, in order. */
  steps: StepBeginEvent[];
  /** The action currently paused and awaiting the user, or null between pauses. */
  awaiting: StepBeginEvent | null;
  /** True after launch until the first pause (or an early finish). */
  starting: boolean;

  /** Launch: mark a case's stepped preview as starting. */
  begin: (caseId: string) => void;
  /** A new action paused. */
  onStep: (e: StepBeginEvent) => void;
  /** User advanced or resumed: clear the pause while the action runs. */
  clearAwaiting: () => void;
  /** The stepped run finished (or was stopped); return to idle. */
  finish: (runId: string) => void;
}

export const useStep = create<StepState>((set) => ({
  runId: null,
  caseId: null,
  steps: [],
  awaiting: null,
  starting: false,

  begin: (caseId) =>
    set({
      runId: `step:${caseId}`,
      caseId,
      steps: [],
      awaiting: null,
      starting: true,
    }),
  onStep: (e) =>
    set((s) =>
      s.runId === e.runId
        ? { steps: [...s.steps, e], awaiting: e, starting: false }
        : s,
    ),
  clearAwaiting: () => set({ awaiting: null }),
  finish: (runId) =>
    set((s) =>
      s.runId === runId
        ? { runId: null, caseId: null, awaiting: null, starting: false }
        : s,
    ),
}));
