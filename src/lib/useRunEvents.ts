import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { runEvents } from "@/lib/ipc";
import { track } from "@/lib/telemetry";
import type { PlaywrightSummary } from "@/lib/types";
import { useActivity } from "@/store/activity";
import { useSession } from "@/store/session";

/** One short line describing how a run finished, for the collapsed bar. */
function summarize(s: PlaywrightSummary): string {
  const passed = s.updated.filter((u) => u.status === "passed").length;
  const failed = s.updated.filter((u) => u.status === "failed").length;
  const parts = [`${passed} passed`, `${failed} failed`];
  if (s.skipped.length) parts.push(`${s.skipped.length} not automated`);
  if (s.unmapped.length) parts.push(`${s.unmapped.length} unmapped`);
  return parts.join(" · ");
}

/**
 * Subscribe to the Playwright run lifecycle events for the whole app: stream
 * lines into the Activity console, and refresh run/dashboard queries when a run
 * finishes. Mounted once in the app shell.
 */
export function useRunEvents() {
  const qc = useQueryClient();
  const setActivity = useSession((s) => s.setActivity);

  useEffect(() => {
    const { start, push, finish } = useActivity.getState();
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const register = (p: Promise<UnlistenFn>) => {
      p.then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      });
    };

    register(
      runEvents.onStarted((e) => {
        start(e.runId);
        push(`> Running ${e.cases} case(s) with Playwright…`);
        setActivity(true);
      }),
    );
    register(runEvents.onLog((e) => push(e.line)));
    register(
      runEvents.onProgress((e) => {
        const el = e.elapsed ? ` (${e.elapsed})` : "";
        push(`  ${e.case}: ${e.status}${el}`);
      }),
    );
    register(
      runEvents.onFinished((e) => {
        if (e.error) {
          push(`x Run failed: ${e.error}`);
          finish(e.error);
        } else if (e.summary) {
          const line = summarize(e.summary);
          push(`Done - ${line}`);
          finish(line);
          // A completed automated run ingested results for this run's cases.
          void track("result_recorded", { source: "playwright" });
        } else {
          finish(null);
        }
        qc.invalidateQueries({ queryKey: ["run", e.runId] });
        qc.invalidateQueries({ queryKey: ["runs"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        qc.invalidateQueries({ queryKey: ["git-status"] });
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [qc, setActivity]);
}
