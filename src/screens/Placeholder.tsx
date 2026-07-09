import { Construction } from "lucide-react";

/** A calm empty state for screens that land in later milestones. */
export function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-subtle px-8 py-5">
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-card border border-border-subtle bg-bg-surface">
            <Construction size={22} className="text-brand-primary" />
          </div>
          <h2 className="mb-1.5 text-base font-medium text-text-primary">
            {title}
          </h2>
          <p className="text-sm leading-relaxed text-text-secondary">{blurb}</p>
        </div>
      </div>
    </div>
  );
}
