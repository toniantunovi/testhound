import { useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "@/lib/ipc";
import { isReferenceUrl, referenceLabel } from "@/lib/references";
import { cn } from "@/lib/utils";

/** One reference: the ticket key, clickable when the value is a link. The full
 *  value stays in the tooltip, so a pasted URL is still readable without taking
 *  a whole row to display. */
export function ReferenceLink({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const label = referenceLabel(value);
  if (!isReferenceUrl(value)) {
    return (
      <span
        title={value}
        className={cn("truncate font-mono text-text-secondary", className)}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      onClick={() => api.openUrl(value)}
      title={value}
      className={cn(
        "truncate text-left font-mono text-brand-primary underline decoration-border-strong decoration-dotted underline-offset-2 hover:decoration-brand-primary",
        className,
      )}
    >
      {label}
    </button>
  );
}

/** Editable list of references, shared by the case editor and the run views.
 *  `layout` picks between a stacked list (a form field with room) and chips
 *  that wrap (a table row or a slide-over section); `collapsible` keeps the
 *  input hidden behind a small button until it is needed, so a table row is not
 *  filled with fields for cases nobody has filed a bug against. */
export function ReferenceEditor({
  references,
  onChange,
  layout = "list",
  collapsible = false,
  placeholder = "AB-1234 or https://…",
  addLabel = "Reference",
  disabled,
}: {
  references: string[];
  onChange: (refs: string[]) => void;
  layout?: "list" | "inline";
  collapsible?: boolean;
  placeholder?: string;
  addLabel?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(!collapsible);

  const add = () => {
    const v = value.trim();
    setValue("");
    if (collapsible) setOpen(false);
    if (!v || references.includes(v)) return;
    onChange([...references, v]);
  };

  const remove = (r: string) => onChange(references.filter((x) => x !== r));

  const inline = layout === "inline";

  return (
    <div className={cn(inline && "flex flex-wrap items-center gap-1.5")}>
      {references.length > 0 && (
        <div
          className={cn(
            inline
              ? "flex flex-wrap items-center gap-1.5"
              : "mb-1.5 flex flex-col gap-1",
          )}
        >
          {references.map((r) => (
            <div
              key={r}
              className={cn(
                "group flex items-center gap-1.5 rounded-control bg-bg-surface-2/60",
                inline ? "px-1.5 py-0.5" : "px-1.5 py-1",
              )}
            >
              <ReferenceLink
                value={r}
                className={cn("min-w-0", inline ? "text-[11px]" : "flex-1 text-xs")}
              />
              <button
                onClick={() => remove(r)}
                disabled={disabled}
                title="Remove reference"
                className="shrink-0 text-text-muted opacity-0 transition-opacity hover:text-status-failed group-hover:opacity-100 disabled:opacity-0"
              >
                <X size={inline ? 11 : 12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {collapsible && !open ? (
        <button
          onClick={() => setOpen(true)}
          disabled={disabled}
          title="Link a bug to this result"
          className="inline-flex items-center gap-1 rounded-control border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-muted hover:border-border-strong hover:text-text-primary disabled:opacity-40"
        >
          <Plus size={11} /> {addLabel}
        </button>
      ) : (
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          autoFocus={collapsible}
          disabled={disabled}
          placeholder={placeholder}
          className={cn(
            "min-w-0 rounded-control border border-border-subtle bg-bg-base px-2 font-mono text-text-primary placeholder:text-text-muted focus:border-border-strong focus:outline-none",
            inline ? "h-7 w-44 text-[11px]" : "h-8 flex-1 text-xs",
          )}
        />
        <button
          onClick={add}
          disabled={disabled || !value.trim()}
          title="Add reference"
          className="rounded-control border border-border-subtle p-1.5 text-text-muted hover:text-text-primary disabled:opacity-40"
        >
          <Plus size={13} />
        </button>
      </div>
      )}
    </div>
  );
}
