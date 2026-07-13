// Hands-off Git for non-Git users (Settings > "Automatic sync", on by
// default). A background loop keeps the repo current without any manual
// staging, committing, pulling, or pushing:
//
//  - When the working tree has been quiet for IDLE_MS, everything is
//    committed with the drafted message and synced (pull + push).
//  - Independent of local edits, the repo pulls/pushes every SYNC_EVERY_MS
//    and once when the project opens, so remote changes flow in.
//  - Sync outcomes reuse useSync in `auto` mode: diverged branches merge and
//    set-aside changes re-apply on their own; only real conflicts wait for a
//    human, surfaced through the repo-bar badge and the Merge view.
//
// The loop stands down whenever committing could capture half-done work or
// fight another writer: during merges/conflicts, on a detached HEAD, while
// the assistant or a generation agent is writing files, while a sync or
// commit is already in flight, and while the user is reviewing on the
// Changes or Merge screens (reviewing there means manual control).
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "@/lib/ipc";
import type { ChangedFile } from "@/lib/types";
import { suggestCommitMessage } from "@/lib/changes";
import { useSync } from "@/lib/useSync";
import { usePrefs } from "@/store/prefs";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";
import { useAssistant } from "@/store/assistant";
import { useAgentDrawer } from "@/store/agent";

/** The working tree must be unchanged this long before it auto-commits. */
const IDLE_MS = 30_000;
/** Background pull/push cadence (also runs right after every auto-commit). */
const SYNC_EVERY_MS = 180_000;
/** How often the loop re-evaluates. */
const TICK_MS = 5_000;

export function useAutoSync() {
  const enabled = usePrefs((s) => s.autoSync);
  const project = useSession((s) => s.project);
  const view = useSession((s) => s.view);
  const assistantBusy = useAssistant((s) => s.busy);
  const agentBusy = useAgentDrawer((s) => s.caseId !== null);
  const push = useActivity((s) => s.push);
  const finish = useActivity((s) => s.finish);
  const qc = useQueryClient();
  const syncFlow = useSync({ auto: true });

  const { data: git } = useQuery({
    queryKey: ["git-status"],
    queryFn: api.gitStatus,
    refetchInterval: TICK_MS,
    enabled: enabled && !!project,
  });
  const { data: conflicts } = useQuery({
    queryKey: ["conflicts"],
    queryFn: api.listConflicts,
    refetchInterval: 15_000,
    enabled: enabled && !!project,
  });

  const commit = useMutation({
    mutationFn: async (files: ChangedFile[]) => {
      const message = suggestCommitMessage(files);
      await api.commitChanges(message, files.map((f) => f.path));
      return { message, count: files.length };
    },
    onSuccess: ({ message, count }) => {
      push(`$ git commit -m "${message.split("\n")[0]}" (${count} files, auto)`);
      qc.invalidateQueries({ queryKey: ["git-status"] });
      syncFlow.sync();
    },
    onError: (e) => {
      push(`error: ${errMsg(e)}`);
      finish("Auto-commit failed, will retry");
    },
  });

  // Track how long the change set has been stable. Saves in TestHound are
  // explicit writes, so a quiet status for IDLE_MS means nothing is mid-save.
  const fingerprint = (git?.changed ?? [])
    .map((f) => `${f.status} ${f.path}`)
    .join("\n");
  const idleSince = useRef(Date.now());
  const lastFingerprint = useRef(fingerprint);
  useEffect(() => {
    if (fingerprint !== lastFingerprint.current) {
      lastFingerprint.current = fingerprint;
      idleSince.current = Date.now();
    }
  }, [fingerprint]);

  const lastSync = useRef(0);

  // Pull once as soon as a project is open, so the user starts from the
  // latest shared state.
  const initialSyncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !project || initialSyncedFor.current === project.repoRoot)
      return;
    initialSyncedFor.current = project.repoRoot;
    lastSync.current = Date.now();
    syncFlow.sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, project]);

  // The tick reads everything through a ref so one stable interval always
  // sees current state (no re-arming on every 5s status refetch).
  const tick = useRef(() => {});
  tick.current = () => {
    if (!enabled || !project || !git) return;
    const busy = commit.isPending || syncFlow.pending || assistantBusy || agentBusy;
    const halted =
      git.detached ||
      conflicts?.merging ||
      (conflicts && conflicts.cases.length + conflicts.other.length > 0);
    if (busy || halted) return;

    // Reviewing on the Changes or Merge screen means manual control: no
    // auto-commit, and no background pull that could race a manual commit.
    const reviewing = view === "changes" || view === "merge";
    if (reviewing) return;

    const now = Date.now();
    if (git.changed.length > 0 && now - idleSince.current >= IDLE_MS) {
      lastSync.current = now; // the commit's onSuccess syncs
      commit.mutate(git.changed);
      return;
    }
    if (now - lastSync.current >= SYNC_EVERY_MS) {
      lastSync.current = now;
      syncFlow.sync();
    }
  };
  useEffect(() => {
    const id = setInterval(() => tick.current(), TICK_MS);
    return () => clearInterval(id);
  }, []);
}
