import { cn } from "@/lib/utils";
import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-brand-primary text-bg-base hover:bg-brand-primary/90 border border-transparent font-medium",
  secondary:
    "bg-bg-surface-2 text-text-primary hover:bg-bg-surface-2/70 border border-border-strong",
  ghost:
    "bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-surface-2 border border-transparent",
  danger:
    "bg-status-failed/10 text-status-failed hover:bg-status-failed/20 border border-status-failed/30",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-8 px-3 text-sm gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded-control transition-colors",
        "disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
