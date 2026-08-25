import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { useActivity } from "@/store/activity";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";

/** Edit and delete for one run, behind a single button. Shared by the run list
 *  and the execution view, so a run is edited and deleted the same way and with
 *  the same confirmation wherever it is looked at. */
export function RunMenu({
  run,
  /** Called once the run is gone: the list stays put, the run view leaves. */
  onDeleted,
  /** Shown on hover; also how the trigger is labelled for a screen reader. */
  title = "Run actions",
  /** True in the run list, where the button appears on the hovered row only. */
  revealOnHover,
}: {
  run: { id: string; name: string };
  onDeleted?: () => void;
  title?: string;
  revealOnHover?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const editRun = useSession((s) => s.editRun);
  const running = useActivity((s) => s.runningRunId) === run.id;
  const qc = useQueryClient();

  const remove = useMutation({
    mutationFn: () => api.deleteRun(run.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["run", run.id] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
      onDeleted?.();
    },
    onError: (e) => useActivity.getState().push(`x ${errMsg(e)}`),
  });

  const confirmDelete = async () => {
    const ok = await ask(
      `Delete run "${run.name}" and the results recorded in it?\n\nThe files are removed from the working tree; review and commit the deletion in the Changes panel.`,
      { title: "Delete run", kind: "warning" },
    );
    if (ok) remove.mutate();
  };

  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={title}
        className={cn(
          "rounded-control p-0.5 text-text-muted transition-opacity hover:bg-bg-surface-2 hover:text-text-primary",
          revealOnHover && !open && "opacity-0 group-hover:opacity-100",
        )}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-card border border-border-strong bg-bg-surface py-1 shadow-xl">
            <Item
              icon={<Pencil size={13} />}
              label="Edit run"
              disabled={
                running
                  ? "This run is executing; wait for it to finish"
                  : undefined
              }
              onClick={act(() => editRun(run.id))}
            />
            <Item
              icon={<Trash2 size={13} />}
              label="Delete run"
              danger
              disabled={
                running
                  ? "This run is executing; wait for it to finish"
                  : undefined
              }
              onClick={act(() => void confirmDelete())}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** One menu row. `disabled` carries the reason, shown on hover. */
function Item({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled !== undefined}
      title={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
        disabled !== undefined
          ? "cursor-not-allowed text-text-muted"
          : danger
          ? "text-status-failed hover:bg-status-failed/10"
          : "text-text-secondary hover:bg-bg-surface-2 hover:text-text-primary",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
