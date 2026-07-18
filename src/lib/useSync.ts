// The shared Sync flow (repo bar button, command palette, and the background
// auto-sync loop): run the fast-forward sync, then route the user based on the
// structured outcome. In the default interactive mode, decisions (merge a
// diverged branch? re-apply stashed changes?) use native dialogs and conflicts
// navigate to the Merge view. In `auto` mode (background sync for non-Git
// users) the safe next step is taken automatically: diverged branches merge,
// set-aside changes re-apply, and only real conflicts wait for the user, who
// is pointed at the Merge view via the repo-bar badge instead of being yanked
// out of whatever they are editing.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errMsg } from "@/lib/ipc";
import { track } from "@/lib/telemetry";
import type { SyncOutcome } from "@/lib/types";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";

export function useSync(opts: { auto?: boolean } = {}) {
  const auto = !!opts.auto;
  const navigate = useSession((s) => s.navigate);
  const setActivity = useSession((s) => s.setActivity);
  const push = useActivity((s) => s.push);
  const finish = useActivity((s) => s.finish);
  const qc = useQueryClient();

  // Git failures land in the activity console; interactively, pop it open so
  // they are seen. The background loop stays quiet and just retries later.
  const surfaceError = (e: unknown) => {
    push(`error: ${errMsg(e)}`);
    finish(auto ? "Sync failed, will retry" : null);
    if (!auto) setActivity(true);
  };

  const handleOutcome = async (out: SyncOutcome) => {
    out.log.split("\n").forEach((l) => l && push(l));
    qc.invalidateQueries({ queryKey: ["git-status"] });
    qc.invalidateQueries({ queryKey: ["conflicts"] });
    // A sync flow reached a terminal state. `diverged` is not terminal: it just
    // kicks off a merge whose outcome lands back here. Record the sync-pain /
    // WAU signal once, tagged with whether it ended in conflicts.
    if (out.status !== "diverged") {
      void track("sync_performed", {
        had_conflict:
          out.status === "conflicts" || out.status === "stash-conflicts",
      });
    }
    switch (out.status) {
      case "ok":
        // A pull may have brought in new cases, runs, or results; refresh
        // everything derived from the working tree.
        qc.invalidateQueries();
        finish("Synced");
        break;
      case "diverged": {
        if (auto) {
          push("local and remote history diverged; merging remote changes");
          mergeRemote.mutate();
          break;
        }
        finish(null);
        const merge = await ask(
          "Your branch and the remote have both changed.\n\n" +
            "Merge the remote changes into your local branch? If files " +
            "conflict, TestHound opens the Merge view to resolve them.",
          {
            title: "Branches have diverged",
            kind: "warning",
            okLabel: "Merge",
            cancelLabel: "Not now",
          },
        );
        if (merge) mergeRemote.mutate();
        break;
      }
      case "conflicts":
        finish(`Merge stopped on ${out.conflictCount} conflict(s)`);
        // Interactively the user asked for this sync, so take them straight
        // to the resolver. In auto mode don't steal focus mid-edit; the
        // repo-bar conflict badge routes them there.
        if (!auto) navigate("merge");
        break;
      case "stash-conflicts": {
        if (auto) {
          push("re-applying local changes that were set aside during sync");
          stashPop.mutate();
          break;
        }
        finish(null);
        const apply = await ask(
          "Your uncommitted changes conflict with the updates that were " +
            "just pulled, so git set them aside in a stash. Nothing is lost.\n\n" +
            "Re-apply them now? Conflicting files open in the Merge view.",
          {
            title: "Local changes set aside",
            kind: "warning",
            okLabel: "Re-apply",
            cancelLabel: "Later",
          },
        );
        if (apply) stashPop.mutate();
        break;
      }
    }
  };

  const sync = useMutation({
    mutationFn: api.syncRepo,
    onMutate: () => push("$ git pull --ff-only --autostash && git push"),
    onSuccess: handleOutcome,
    onError: surfaceError,
  });

  const mergeRemote = useMutation({
    mutationFn: api.mergeRemote,
    onSuccess: handleOutcome,
    onError: surfaceError,
  });

  const stashPop = useMutation({
    mutationFn: api.stashPop,
    onSuccess: (out) => {
      // A clean re-apply restores working-tree changes; refresh what shows them.
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["suites"] });
      return handleOutcome(out);
    },
    onError: surfaceError,
  });

  return {
    sync: () => sync.mutate(),
    pending: sync.isPending || mergeRemote.isPending || stashPop.isPending,
  };
}
