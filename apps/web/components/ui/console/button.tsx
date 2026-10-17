import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../../lib/utils";

/**
 * Console buttons (KOBE-294), shadcn's pattern on the console palette. Secondary is the default
 * (most console actions); primary is the page's main action; danger is for removing, revoking and
 * leaving, outlined so its text keeps contrast in both themes. No preflight on these pages, so the
 * classes reset the browser's button look themselves.
 */
export const buttonVariants = cva(
  "m-0 box-border inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border font-[inherit] text-sm leading-5 font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-status-accent text-status-accent-fg hover:enabled:bg-status-accent/90",
        secondary:
          "border-console-border bg-console-bg text-console-fg hover:enabled:bg-console-panel",
        danger:
          "border-console-danger bg-console-bg text-console-danger hover:enabled:bg-console-danger-bg",
      },
      size: {
        default: "min-h-8 px-3 py-1",
        sm: "min-h-7 px-2 py-0.5 text-xs",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="console-button"
      data-variant={variant ?? "secondary"}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
