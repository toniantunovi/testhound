// The shared Sync flow (repo bar button and command palette): run the
// fast-forward sync, then route the user based on the structured outcome.
// Decisions (merge a diverged branch? re-apply stashed changes?) use native
// dialogs; conflicts navigate to the Merge view, which owns resolution.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errMsg } from "@/lib/ipc";
import type { SyncOutcome } from "@/lib/types";
import { useSession } from "@/store/session";
import { useActivity } from "@/store/activity";

export function useSync() {
  const navigate = useSession((s) => s.navigate);
  const setActivity = useSession((s) => s.setActivity);
  const push = useActivity((s) => s.push);
  const finish = useActivity((s) => s.finish);
  const qc = useQueryClient();

  // Git failures land in the activity console; pop it open so they are seen.
  const surfaceError = (e: unknown) => {
    push(`error: ${errMsg(e)}`);
    finish(null);
    setActivity(true);
  };

  const handleOutcome = async (out: SyncOutcome) => {
    out.log.split("\n").forEach((l) => l && push(l));
    qc.invalidateQueries({ queryKey: ["git-status"] });
    qc.invalidateQueries({ queryKey: ["conflicts"] });
    switch (out.status) {
      case "ok":
        finish("Synced");
        break;
      case "diverged": {
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
        navigate("merge");
        break;
      case "stash-conflicts": {
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
