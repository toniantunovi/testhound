import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, FileCode2, Save, X } from "lucide-react";
import { api, errMsg } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { CodeEditor } from "@/components/ui/CodeEditor";

/** View and hand-edit a linked spec's source. Saving writes straight to the
 *  working tree (like any editor would); the change is reviewed and committed
 *  in the Changes panel. */
export function SpecEditorModal({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const { data: loaded, error } = useQuery({
    queryKey: ["spec-source", path],
    queryFn: () => api.readSpec(path),
  });

  useEffect(() => {
    if (loaded !== undefined && text === null) {
      setText(loaded);
    }
  }, [loaded, text]);

  const save = useMutation({
    mutationFn: (content: string) => api.writeSpec(path, content),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["spec-source", path] });
      qc.invalidateQueries({ queryKey: ["git-status"] });
    },
    onError: (e) => window.alert(errMsg(e)),
  });

  const requestClose = () => {
    if (save.isPending) return;
    if (dirty && !window.confirm("Discard unsaved changes to this spec?")) {
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/40" onClick={requestClose} />
      <div className="relative flex max-h-[88vh] w-[880px] max-w-full flex-col overflow-hidden rounded-card border border-border-subtle bg-bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
          <FileCode2 size={15} className="text-brand-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-primary">
              Spec source
            </div>
            <div className="truncate font-mono text-[11px] text-text-muted">
              {path}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            title="Open in your code editor"
            onClick={() => api.openInEditor(path).catch((e) => window.alert(errMsg(e)))}
          >
            <ExternalLink size={13} />
            Open in editor
          </Button>
          <button
            onClick={requestClose}
            className="text-text-muted hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          {error ? (
            <p className="text-xs text-status-failed">{errMsg(error)}</p>
          ) : text === null ? (
            <p className="text-xs text-text-muted">Loading spec…</p>
          ) : (
            <div className="h-[62vh] w-full flex-1 overflow-hidden rounded-card border border-border-subtle bg-bg-base focus-within:border-border-strong">
              <CodeEditor
                value={text}
                onChange={(next) => {
                  setText(next);
                  setDirty(true);
                }}
                onSave={() => {
                  if (dirty && !save.isPending) save.mutate(text);
                }}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border-subtle px-5 py-3">
          <p className="flex-1 text-xs text-text-muted">
            Saving writes to the working tree; review and commit the change in
            the Changes panel.
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || text === null || save.isPending}
            onClick={() => text !== null && save.mutate(text)}
          >
            {save.isSuccess && !dirty ? <Check size={13} /> : <Save size={13} />}
            {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>
    </div>
  );
}
